import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { sha256 } from '../src/crypto.js';
import { LocalImmutableObjectStore } from '../src/object-store.js';
import { PostgresCloudDriveRepository } from '../src/postgres-repository.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the PostgreSQL smoke test');

const token = 'cloud-drive-smoke-owner-token-0001';
const fixtureMarker = 'SYNTHETIC-PRIVATE-CLOUD-DRIVE-FIXTURE';
const fixture = Buffer.alloc(150_000);
for (let index = 0; index < fixture.length; index += 1) {
  fixture[index] = fixtureMarker.charCodeAt(index % fixtureMarker.length);
}
const expectedSha256 = sha256(fixture);
const objectRoot = await mkdtemp(join(tmpdir(), 'cloud-drive-process-smoke-'));

function startProcess(extraEnvironment = {}) {
  const child = spawn(process.execPath, ['src/main.js', 'serve'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      AUTH_TOKENS_JSON: JSON.stringify([token]),
      CURSOR_SECRET: 'smoke-cursor-secret-is-long-enough-0001',
      HOST: '127.0.0.1',
      OBJECT_ROOT: objectRoot,
      PORT: '0',
      ...extraEnvironment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events = new EventEmitter();
  const records = [];
  let stdoutBuffer = '';
  let stderr = '';
  let exited = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const record = JSON.parse(line);
      records.push(record);
      events.emit('record', record);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal, stderr });
    });
  });
  return { child, events, exit, records, hasExited: () => exited };
}

async function waitForRecord(processHandle, kind, timeoutMs = 5_000) {
  const existing = processHandle.records.find((record) => record.kind === kind);
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${kind}`));
    }, timeoutMs);
    const onRecord = (record) => {
      if (record.kind !== kind) return;
      cleanup();
      resolve(record);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      processHandle.events.removeListener('record', onRecord);
    };
    processHandle.events.on('record', onRecord);
  });
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.hasExited()) return processHandle?.exit;
  processHandle.child.kill('SIGTERM');
  const result = await processHandle.exit;
  assert.equal(result.code, 0, result.stderr);
  return result;
}

async function startApi(environment = {}) {
  const processHandle = startProcess(environment);
  const ready = await waitForRecord(processHandle, 'api_listening');
  return { processHandle, baseUrl: `http://127.0.0.1:${ready.port}` };
}

async function request(baseUrl, path, {
  method = 'GET',
  headers = {},
  json,
  bytes,
} = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(json === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: json === undefined ? bytes : JSON.stringify(json),
  });
}

async function uploadBytes(baseUrl, bytes, uploadKey) {
  const openedResponse = await request(baseUrl, '/v1/uploads', {
    method: 'POST',
    headers: { 'idempotency-key': uploadKey },
    json: { expectedBytes: bytes.length, expectedSha256: sha256(bytes) },
  });
  assert.equal(openedResponse.status, 201);
  const opened = await openedResponse.json();
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const chunk = bytes.subarray(offset, Math.min(offset + 65_536, bytes.length));
    const response = await request(baseUrl, `/v1/uploads/${opened.upload.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/offset+octet-stream',
        'idempotency-key': `${uploadKey}-chunk-${String(index).padStart(4, '0')}`,
        'upload-offset': String(offset),
      },
      bytes: chunk,
    });
    assert.equal(response.status, 201);
    offset = (await response.json()).offset;
    index += 1;
  }
  const finalizedResponse = await request(baseUrl, `/v1/uploads/${opened.upload.id}/finalize`, { method: 'POST' });
  assert.equal(finalizedResponse.status, 201);
  return opened.upload.id;
}

const inspectionPool = new Pool({ connectionString: process.env.DATABASE_URL });
await inspectionPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
const inspectionRepository = new PostgresCloudDriveRepository(
  inspectionPool,
  new LocalImmutableObjectStore(objectRoot),
);
await inspectionRepository.migrate();

const processes = [];
try {
  const uploadKey = 'smoke-upload-response-loss-0001';
  const firstChunkKey = 'smoke-chunk-response-loss-0001';
  const crashingChunkApi = await startApi({ CLOCK_MS: '1000', CRASH_AFTER_CHUNK_COMMIT: '1' });
  processes.push(crashingChunkApi.processHandle);
  const openedResponse = await request(crashingChunkApi.baseUrl, '/v1/uploads', {
    method: 'POST',
    headers: { 'idempotency-key': uploadKey },
    json: { expectedBytes: fixture.length, expectedSha256 },
  });
  assert.equal(openedResponse.status, 201);
  const opened = await openedResponse.json();
  const firstChunk = fixture.subarray(0, 65_536);
  await assert.rejects(request(crashingChunkApi.baseUrl, `/v1/uploads/${opened.upload.id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/offset+octet-stream',
      'idempotency-key': firstChunkKey,
      'upload-offset': '0',
    },
    bytes: firstChunk,
  }));
  const chunkCrash = await crashingChunkApi.processHandle.exit;
  assert.equal(chunkCrash.signal, 'SIGKILL');

  let api = await startApi({ CLOCK_MS: '2000' });
  processes.push(api.processHandle);
  const chunkReplayResponse = await request(api.baseUrl, `/v1/uploads/${opened.upload.id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/offset+octet-stream',
      'idempotency-key': firstChunkKey,
      'upload-offset': '0',
    },
    bytes: firstChunk,
  });
  assert.equal(chunkReplayResponse.status, 200);
  const chunkReplay = await chunkReplayResponse.json();
  assert.equal(chunkReplay.created, false);
  assert.equal(chunkReplay.offset, 65_536);

  const boundaries = [65_536, 131_072, fixture.length];
  for (let index = 1; index < boundaries.length; index += 1) {
    const start = boundaries[index - 1];
    const end = boundaries[index];
    const response = await request(api.baseUrl, `/v1/uploads/${opened.upload.id}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/offset+octet-stream',
        'idempotency-key': `smoke-chunk-response-loss-${String(index + 1).padStart(4, '0')}`,
        'upload-offset': String(start),
      },
      bytes: fixture.subarray(start, end),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json()).offset, end);
  }
  const finalizedResponse = await request(api.baseUrl, `/v1/uploads/${opened.upload.id}/finalize`, { method: 'POST' });
  assert.equal(finalizedResponse.status, 201);
  await stopProcess(api.processHandle);

  const createKey = 'smoke-create-response-loss-0001';
  const createIntent = { name: 'Smoke.bin', uploadId: opened.upload.id };
  const crashingMutationApi = await startApi({ CLOCK_MS: '3000', CRASH_AFTER_MUTATION_COMMIT: '1' });
  processes.push(crashingMutationApi.processHandle);
  await assert.rejects(request(crashingMutationApi.baseUrl, '/v1/files', {
    method: 'POST',
    headers: { 'idempotency-key': createKey },
    json: createIntent,
  }));
  const mutationCrash = await crashingMutationApi.processHandle.exit;
  assert.equal(mutationCrash.signal, 'SIGKILL');

  api = await startApi({ CLOCK_MS: '4000' });
  processes.push(api.processHandle);
  const createReplayResponse = await request(api.baseUrl, '/v1/files', {
    method: 'POST',
    headers: { 'idempotency-key': createKey },
    json: createIntent,
  });
  assert.equal(createReplayResponse.status, 200);
  const createReplay = await createReplayResponse.json();
  assert.equal(createReplay.receiptCreated, false);
  assert.equal(createReplay.applied, true);
  assert.equal(createReplay.revision, 1);

  const rangeResponse = await request(api.baseUrl, `/v1/files/${createReplay.fileId}/content`, {
    headers: { range: 'bytes=10-19' },
  });
  assert.equal(rangeResponse.status, 206);
  assert.equal(rangeResponse.headers.get('content-range'), `bytes 10-19/${fixture.length}`);
  assert.ok(Buffer.from(await rangeResponse.arrayBuffer()).equals(fixture.subarray(10, 20)));
  const bytesWritten = await waitForRecord(api.processHandle, 'server_bytes_written');
  assert.equal(bytesWritten.bytes, 10);

  const secondBytes = Buffer.from('synthetic second file');
  const secondUpload = await uploadBytes(api.baseUrl, secondBytes, 'smoke-second-upload-key-0001');
  const secondCreateResponse = await request(api.baseUrl, '/v1/files', {
    method: 'POST',
    headers: { 'idempotency-key': 'smoke-second-create-key-0001' },
    json: { name: 'Second.txt', uploadId: secondUpload },
  });
  assert.equal(secondCreateResponse.status, 201);
  assert.equal((await secondCreateResponse.json()).revision, 2);

  const startResponse = await request(api.baseUrl, '/v1/change-tokens', {
    method: 'POST',
    json: { position: 'beginning' },
  });
  assert.equal(startResponse.status, 201);
  const startToken = (await startResponse.json()).pageToken;
  const firstPageResponse = await request(
    api.baseUrl,
    `/v1/changes?pageToken=${encodeURIComponent(startToken)}&limit=1`,
  );
  assert.equal(firstPageResponse.status, 200);
  const firstPage = await firstPageResponse.json();
  assert.deepEqual(firstPage.changes.map((change) => change.revision), [1]);
  assert.ok(firstPage.nextPageToken);

  const updatedBytes = Buffer.from('synthetic updated file');
  const updateUpload = await uploadBytes(api.baseUrl, updatedBytes, 'smoke-update-upload-key-0001');
  const updateResponse = await request(api.baseUrl, `/v1/files/${createReplay.fileId}`, {
    method: 'PUT',
    headers: {
      'idempotency-key': 'smoke-update-file-key-0001',
      'if-match': createReplay.versionEtag,
    },
    json: { uploadId: updateUpload },
  });
  assert.equal(updateResponse.status, 200);
  const updated = await updateResponse.json();
  assert.equal(updated.revision, 3);

  const frozenSecondResponse = await request(
    api.baseUrl,
    `/v1/changes?pageToken=${encodeURIComponent(firstPage.nextPageToken)}&limit=1`,
  );
  assert.equal(frozenSecondResponse.status, 200);
  const frozenSecond = await frozenSecondResponse.json();
  assert.deepEqual(frozenSecond.changes.map((change) => change.revision), [2]);
  assert.equal(frozenSecond.nextPageToken, null);
  assert.ok(frozenSecond.newStartPageToken);
  const laterResponse = await request(
    api.baseUrl,
    `/v1/changes?pageToken=${encodeURIComponent(frozenSecond.newStartPageToken)}&limit=10`,
  );
  assert.equal(laterResponse.status, 200);
  const later = await laterResponse.json();
  assert.deepEqual(later.changes.map((change) => change.revision), [3]);

  const staleIntent = { uploadId: secondUpload };
  const staleResponse = await request(api.baseUrl, `/v1/files/${createReplay.fileId}`, {
    method: 'PUT',
    headers: {
      'idempotency-key': 'smoke-stale-update-key-0001',
      'if-match': createReplay.versionEtag,
    },
    json: staleIntent,
  });
  assert.equal(staleResponse.status, 412);
  const stale = await staleResponse.json();
  assert.equal(stale.revision, null);
  assert.equal(stale.currentVersionEtag, updated.versionEtag);
  const staleReplayResponse = await request(api.baseUrl, `/v1/files/${createReplay.fileId}`, {
    method: 'PUT',
    headers: {
      'idempotency-key': 'smoke-stale-update-key-0001',
      'if-match': createReplay.versionEtag,
    },
    json: staleIntent,
  });
  assert.equal(staleReplayResponse.status, 412);
  assert.equal((await staleReplayResponse.json()).receiptCreated, false);

  const deleteResponse = await request(api.baseUrl, `/v1/files/${createReplay.fileId}`, {
    method: 'DELETE',
    headers: {
      'idempotency-key': 'smoke-delete-file-key-0001',
      'if-match': updated.versionEtag,
    },
  });
  assert.equal(deleteResponse.status, 200);
  assert.equal((await deleteResponse.json()).revision, 4);
  assert.equal((await request(api.baseUrl, `/v1/files/${createReplay.fileId}`)).status, 410);
  assert.equal((await request(api.baseUrl, `/v1/files/${createReplay.fileId}/content`)).status, 410);

  const stats = await inspectionRepository.stats();
  assert.equal(stats.accounts, 1);
  assert.deepEqual(stats.uploads, { consumed: 3 });
  assert.equal(stats.chunks, 5);
  assert.deepEqual(stats.files, { active: 1, tombstoned: 1 });
  assert.equal(stats.versions, 3);
  assert.deepEqual(stats.mutations, { applied: 4, precondition_failed: 1 });
  assert.equal(stats.changes, 4);

  const allLogs = JSON.stringify(processes.flatMap((processHandle) => processHandle.records));
  const sensitiveValues = [
    token,
    uploadKey,
    firstChunkKey,
    createKey,
    fixtureMarker,
    expectedSha256,
    opened.upload.id,
    createReplay.fileId,
    createReplay.versionEtag,
    startToken,
    objectRoot,
    'Smoke.bin',
    'Second.txt',
  ];
  for (const secret of sensitiveValues) assert.ok(!allLogs.includes(secret), `structured log leaked: ${secret}`);

  process.stdout.write(`${JSON.stringify({
    kind: 'postgres_cloud_drive_sync_smoke_receipt',
    chunkCrashSignal: chunkCrash.signal,
    chunkRetryCreated: chunkReplay.created,
    committedOffset: fixture.length,
    mutationCrashSignal: mutationCrash.signal,
    mutationRetryReceiptCreated: createReplay.receiptCreated,
    committedRevisions: stats.changes,
    frozenPageExcludedLaterRevision: !frozenSecond.changes.some((change) => change.revision === 3),
    laterCheckpointIncludedRevision: later.changes[0].revision,
    staleRevisionAllocated: stale.revision,
    rangeStatus: rangeResponse.status,
    bytesWrittenEvidence: bytesWritten.evidence,
    tombstoneDeniedReads: true,
    deviceReceiptClaims: 0,
    deviceApplyClaims: 0,
    convergenceClaims: 0,
    humanViewClaims: 0,
  })}\n`);
} finally {
  for (const processHandle of [...processes].reverse()) await stopProcess(processHandle);
  await inspectionPool.end();
}
