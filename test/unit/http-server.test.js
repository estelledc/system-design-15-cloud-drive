import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createHttpServer } from '../../src/http-server.js';

const token = 'http-owner-token-0001';
const fileId = '00000000-0000-4000-8000-000000000001';
const versionId = '00000000-0000-4000-8000-000000000002';
const uploadId = '00000000-0000-4000-8000-000000000003';
const etag = `"${versionId}"`;

function serviceStub() {
  return {
    async openUpload() {
      return { created: true, upload: { id: uploadId, expectedBytes: 6, offset: 0, state: 'uploading' }, evidence: 'upload_opened' };
    },
    async createFile() {
      return {
        receiptCreated: true,
        applied: true,
        outcome: 'applied',
        fileId,
        versionEtag: etag,
        currentVersionEtag: null,
        revision: 1,
        evidence: 'mutation_committed',
      };
    },
    async updateFile() {
      return {
        receiptCreated: true,
        applied: false,
        outcome: 'precondition_failed',
        fileId,
        versionEtag: null,
        currentVersionEtag: etag,
        revision: null,
        evidence: 'precondition_failed',
      };
    },
    async readFile() {
      return { id: fileId, name: 'Report.txt', version: 1, bytes: 6, etag, evidence: 'file_metadata_response' };
    },
    async readContent() {
      return {
        status: 206,
        start: 1,
        end: 3,
        length: 3,
        totalBytes: 6,
        bytes: Buffer.from('bcd'),
        etag,
        evidence: 'server_bytes_written',
      };
    },
    async createStartToken() {
      return { pageToken: 'signed-checkpoint-token', evidence: 'change_checkpoint_issued' };
    },
    async listChanges() {
      return {
        changes: [{ revision: 1, fileId, kind: 'created', name: 'Report.txt', bytes: 6, versionEtag: etag }],
        nextPageToken: null,
        newStartPageToken: 'signed-next-checkpoint',
        evidence: 'change_page_response',
      };
    },
  };
}

async function withServer(run, overrides = {}) {
  const logs = [];
  const server = createHttpServer({
    service: serviceStub(),
    authTokens: new Set([token]),
    logger: (record) => logs.push(record),
    ...overrides,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`, logs);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function authenticated(init = {}) {
  return { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } };
}

test('authenticated create returns committed ETag and invokes post-commit hook', async () => {
  const callbacks = [];
  await withServer(async (baseUrl, logs) => {
    const response = await fetch(`${baseUrl}/v1/files`, authenticated({
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'http-create-key-0001' },
      body: JSON.stringify({ name: 'Report.txt', uploadId }),
    }));
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('etag'), etag);
    assert.equal((await response.json()).evidence, 'mutation_committed');
    assert.equal(callbacks.length, 1);
    assert.ok(logs.some((record) => record.kind === 'mutation_committed' && record.operation === 'create'));
    assert.ok(!JSON.stringify(logs).includes(fileId));
    assert.ok(!JSON.stringify(logs).includes('Report.txt'));
  }, { afterMutationCommitted: async (result) => callbacks.push(result) });
});

test('stale update returns durable 412 and current strong ETag', async () => {
  await withServer(async (baseUrl, logs) => {
    const response = await fetch(`${baseUrl}/v1/files/${fileId}`, authenticated({
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'http-update-key-0001',
        'if-match': `"00000000-0000-4000-8000-000000000004"`,
      },
      body: JSON.stringify({ uploadId }),
    }));
    assert.equal(response.status, 412);
    assert.equal(response.headers.get('etag'), etag);
    const body = await response.json();
    assert.equal(body.applied, false);
    assert.equal(body.evidence, 'precondition_failed');
    assert.ok(logs.some((record) => record.kind === 'precondition_failed'));
  });
});

test('change pages and range responses remain private server evidence', async () => {
  await withServer(async (baseUrl, logs) => {
    const changes = await fetch(
      `${baseUrl}/v1/changes?pageToken=signed-checkpoint-token&limit=10`,
      authenticated(),
    );
    assert.equal(changes.status, 200);
    assert.equal(changes.headers.get('cache-control'), 'private, no-store');
    assert.equal((await changes.json()).changes.length, 1);

    const content = await fetch(`${baseUrl}/v1/files/${fileId}/content`, authenticated({
      headers: { range: 'bytes=1-3' },
    }));
    assert.equal(content.status, 206);
    assert.equal(content.headers.get('content-range'), 'bytes 1-3/6');
    assert.equal(Buffer.from(await content.arrayBuffer()).toString(), 'bcd');
    assert.ok(logs.some((record) => record.kind === 'server_bytes_written' && record.bytes === 3));
    assert.ok(!JSON.stringify(logs).includes('device_applied'));
    assert.ok(!JSON.stringify(logs).includes('sync_completed'));
  });
});

test('authentication and exact change-query shape fail before service results', async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/v1/files/${fileId}`)).status, 401);
    const duplicate = await fetch(
      `${baseUrl}/v1/changes?pageToken=a&pageToken=b&limit=10`,
      authenticated(),
    );
    assert.equal(duplicate.status, 400);
    assert.deepEqual(await duplicate.json(), { error: 'invalid_request' });
  });
});
