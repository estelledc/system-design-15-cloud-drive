import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { CloudDriveService } from '../src/cloud-drive-service.js';
import { CursorCodec } from '../src/cursor-codec.js';
import { sha256 } from '../src/crypto.js';
import { LocalImmutableObjectStore } from '../src/object-store.js';
import { PostgresCloudDriveRepository } from '../src/postgres-repository.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the PostgreSQL benchmark');

function rate(count, started) {
  return Number((count / ((performance.now() - started) / 1_000)).toFixed(3));
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const objectRoot = await mkdtemp(join(tmpdir(), 'cloud-drive-benchmark-'));
const repository = new PostgresCloudDriveRepository(pool, new LocalImmutableObjectStore(objectRoot));
await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
await repository.migrate();

let clock = 1_000;
const service = new CloudDriveService(
  repository,
  new CursorCodec('benchmark-cursor-secret-is-long-enough-0001'),
  { now: () => clock },
);
const ownerToken = 'benchmark-cloud-drive-token-0001';
const sourceBytes = 524_288;
const chunkBytes = 8_192;
const source = Buffer.allocUnsafe(sourceBytes);
for (let index = 0; index < source.length; index += 1) source[index] = (index * 31 + 17) & 0xff;
const runId = randomUUID();

const opened = await service.openUpload({
  ownerToken,
  idempotencyKey: `benchmark-upload-${runId}`,
  request: { expectedBytes: source.length, expectedSha256: sha256(source) },
});
const chunkCount = Math.ceil(source.length / chunkBytes);
const uploadStarted = performance.now();
for (let index = 0; index < chunkCount; index += 1) {
  const start = index * chunkBytes;
  const bytes = source.subarray(start, Math.min(start + chunkBytes, source.length));
  await service.commitChunk({
    ownerToken,
    uploadId: opened.upload.id,
    idempotencyKey: `benchmark-chunk-${runId}-${String(index).padStart(4, '0')}`,
    offset: start,
    bytes: Buffer.from(bytes),
  });
}
const uploadChunksPerSecond = rate(chunkCount, uploadStarted);

const finalizeStarted = performance.now();
await service.finalizeUpload({ ownerToken, uploadId: opened.upload.id });
const finalizeMilliseconds = Number((performance.now() - finalizeStarted).toFixed(3));
const created = await service.createFile({
  ownerToken,
  idempotencyKey: `benchmark-create-${runId}`,
  request: { name: 'Benchmark.bin', uploadId: opened.upload.id },
});
assert.equal(created.revision, 1);

const updateCount = 50;
let versionEtag = created.versionEtag;
const updatesStarted = performance.now();
for (let index = 0; index < updateCount; index += 1) {
  clock += 1;
  const bytes = Buffer.alloc(2_048, index + 1);
  const upload = await service.openUpload({
    ownerToken,
    idempotencyKey: `benchmark-version-upload-${runId}-${String(index).padStart(4, '0')}`,
    request: { expectedBytes: bytes.length, expectedSha256: sha256(bytes) },
  });
  await service.commitChunk({
    ownerToken,
    uploadId: upload.upload.id,
    idempotencyKey: `benchmark-version-chunk-${runId}-${String(index).padStart(4, '0')}`,
    offset: 0,
    bytes,
  });
  await service.finalizeUpload({ ownerToken, uploadId: upload.upload.id });
  const updated = await service.updateFile({
    ownerToken,
    fileId: created.fileId,
    idempotencyKey: `benchmark-update-${runId}-${String(index).padStart(4, '0')}`,
    ifMatch: versionEtag,
    request: { uploadId: upload.upload.id },
  });
  assert.equal(updated.applied, true);
  versionEtag = updated.versionEtag;
}
const versionCyclesPerSecond = rate(updateCount, updatesStarted);

const start = await service.createStartToken({ ownerToken, request: { position: 'beginning' } });
const pageQueries = 300;
let observedChanges = 0;
const pagesStarted = performance.now();
for (let index = 0; index < pageQueries; index += 1) {
  const page = await service.listChanges({ ownerToken, pageToken: start.pageToken, limit: 100 });
  assert.equal(page.nextPageToken, null);
  assert.equal(page.changes.length, updateCount + 1);
  observedChanges += page.changes.length;
}
const changeRowsPerSecond = rate(observedChanges, pagesStarted);
const version = await pool.query('SHOW server_version');
const stats = await repository.stats();
assert.equal(stats.versions, updateCount + 1);
assert.equal(stats.changes, updateCount + 1);

process.stdout.write(`${JSON.stringify({
  kind: 'postgres_cloud_drive_benchmark_receipt',
  node: process.versions.node,
  postgres: version.rows[0].server_version,
  sourceBytes,
  chunkBytes,
  chunkCount,
  uploadChunksPerSecond,
  finalizeMilliseconds,
  updateCount,
  versionCyclesPerSecond,
  pageQueries,
  observedChanges,
  changeRowsPerSecond,
  filesystem: 'runner-local-temporary-directory',
  remoteNetwork: false,
  deviceApply: false,
})}\n`);

await pool.end();
