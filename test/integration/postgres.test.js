import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { Pool } from 'pg';
import { CloudDriveService } from '../../src/cloud-drive-service.js';
import { CursorCodec } from '../../src/cursor-codec.js';
import { sha256 } from '../../src/crypto.js';
import {
  GoneError,
  IntegrityError,
  OffsetConflictError,
  RequestConflictError,
  ValidationError,
} from '../../src/errors.js';
import { LocalImmutableObjectStore } from '../../src/object-store.js';
import { PostgresCloudDriveRepository } from '../../src/postgres-repository.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ownerToken = 'integration-drive-owner-token-0001';
const otherOwnerToken = 'integration-drive-owner-token-0002';
let repository;
let service;
let objectRoot;
let nowMs;

before(async () => {
  await pool.query('SELECT 1');
});

beforeEach(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  objectRoot = await mkdtemp(join(tmpdir(), 'drive-postgres-objects-'));
  repository = new PostgresCloudDriveRepository(pool, new LocalImmutableObjectStore(objectRoot));
  await repository.migrate();
  nowMs = 1_000;
  service = new CloudDriveService(repository, new CursorCodec('integration-cursor-secret-is-long-enough-0001'), {
    now: () => nowMs,
  });
});

after(async () => {
  await pool.end();
});

async function openUpload(bytes, key = `upload-${randomUUID()}`, expectedSha256 = sha256(bytes), token = ownerToken) {
  return service.openUpload({
    ownerToken: token,
    idempotencyKey: key,
    request: { expectedBytes: bytes.length, expectedSha256 },
  });
}

async function commitBytes(uploadId, bytes, { chunkBytes = 32_768, token = ownerToken } = {}) {
  let offset = 0;
  let index = 0;
  while (offset < bytes.length) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkBytes, bytes.length));
    await service.commitChunk({
      ownerToken: token,
      uploadId,
      idempotencyKey: `chunk-${String(index).padStart(4, '0')}-${randomUUID()}`,
      offset,
      bytes: Buffer.from(chunk),
    });
    offset += chunk.length;
    index += 1;
  }
}

async function finalizedUpload(bytes, key = `upload-${randomUUID()}`, token = ownerToken) {
  const opened = await openUpload(bytes, key, sha256(bytes), token);
  await commitBytes(opened.upload.id, bytes, { token });
  await service.finalizeUpload({ ownerToken: token, uploadId: opened.upload.id });
  return opened.upload.id;
}

async function createdFile(bytes, name = 'Report.txt', key = `create-${randomUUID()}`) {
  const uploadId = await finalizedUpload(bytes);
  return service.createFile({ ownerToken, idempotencyKey: key, request: { name, uploadId } });
}

test('concurrent upload identity and offset races converge without duplicate acceptance', async () => {
  const bytes = Buffer.from('abcdef');
  const request = {
    ownerToken,
    idempotencyKey: 'concurrent-upload-key-0001',
    request: { expectedBytes: bytes.length, expectedSha256: sha256(bytes) },
  };
  const opened = await Promise.all(Array.from({ length: 20 }, () => service.openUpload(request)));
  assert.equal(opened.filter((result) => result.created).length, 1);
  assert.equal(new Set(opened.map((result) => result.upload.id)).size, 1);
  await assert.rejects(service.openUpload({
    ...request,
    request: { ...request.request, expectedBytes: bytes.length + 1 },
  }), RequestConflictError);

  const uploadId = opened[0].upload.id;
  const first = {
    ownerToken,
    uploadId,
    idempotencyKey: 'racing-chunk-key-0001',
    offset: 0,
    bytes: Buffer.from('abc'),
  };
  const competitor = { ...first, idempotencyKey: 'racing-chunk-key-0002' };
  const raced = await Promise.allSettled([service.commitChunk(first), service.commitChunk(competitor)]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(raced.filter((result) => result.status === 'rejected' && result.reason instanceof OffsetConflictError).length, 1);
  const winner = raced[0].status === 'fulfilled' ? first : competitor;
  assert.equal((await service.commitChunk(winner)).created, false);
  await service.commitChunk({
    ownerToken,
    uploadId,
    idempotencyKey: 'racing-chunk-key-0003',
    offset: 3,
    bytes: Buffer.from('def'),
  });
  assert.equal((await service.finalizeUpload({ ownerToken, uploadId })).created, true);
  assert.equal((await service.finalizeUpload({ ownerToken, uploadId })).created, false);
});

test('full digest failure creates no file-visible version', async () => {
  const bytes = Buffer.from('digest-gated-file');
  const opened = await openUpload(bytes, 'wrong-digest-upload-0001', '0'.repeat(64));
  await commitBytes(opened.upload.id, bytes);
  await assert.rejects(service.finalizeUpload({ ownerToken, uploadId: opened.upload.id }), IntegrityError);
  const stats = await repository.stats();
  assert.deepEqual(stats.uploads, { uploading: 1 });
  assert.deepEqual(stats.files, {});
  assert.equal(stats.versions, 0);
  assert.equal(stats.changes, 0);
});

test('same-name creates serialize to one revision and one durable namespace conflict', async () => {
  const firstUpload = await finalizedUpload(Buffer.from('first file'));
  const secondUpload = await finalizedUpload(Buffer.from('second file'));
  const firstRequest = {
    ownerToken,
    idempotencyKey: 'same-name-create-key-0001',
    request: { name: 'Report.txt', uploadId: firstUpload },
  };
  const secondRequest = {
    ownerToken,
    idempotencyKey: 'same-name-create-key-0002',
    request: { name: 'report.TXT', uploadId: secondUpload },
  };
  const results = await Promise.all([service.createFile(firstRequest), service.createFile(secondRequest)]);
  const applied = results.find((result) => result.applied);
  const conflict = results.find((result) => !result.applied);
  assert.equal(applied.revision, 1);
  assert.equal(conflict.outcome, 'namespace_conflict');
  assert.equal(conflict.revision, null);
  const replayRequest = conflict === results[0] ? firstRequest : secondRequest;
  const replay = await service.createFile(replayRequest);
  assert.equal(replay.receiptCreated, false);
  assert.equal(replay.outcome, 'namespace_conflict');
  const stats = await repository.stats();
  assert.deepEqual(stats.files, { active: 1 });
  assert.equal(stats.versions, 1);
  assert.deepEqual(stats.mutations, { applied: 1, namespace_conflict: 1 });
  assert.equal(stats.changes, 1);
});

test('two updates from one base produce one version and one durable 412 outcome', async () => {
  const initial = await createdFile(Buffer.from('base file'), 'Concurrent.txt', 'base-create-key-0001');
  const firstBytes = Buffer.from('winner candidate one');
  const secondBytes = Buffer.from('winner candidate two');
  const firstUpload = await finalizedUpload(firstBytes);
  const secondUpload = await finalizedUpload(secondBytes);
  const firstRequest = {
    ownerToken,
    fileId: initial.fileId,
    idempotencyKey: 'concurrent-update-key-0001',
    ifMatch: initial.versionEtag,
    request: { uploadId: firstUpload },
  };
  const secondRequest = {
    ownerToken,
    fileId: initial.fileId,
    idempotencyKey: 'concurrent-update-key-0002',
    ifMatch: initial.versionEtag,
    request: { uploadId: secondUpload },
  };
  const results = await Promise.all([service.updateFile(firstRequest), service.updateFile(secondRequest)]);
  const applied = results.find((result) => result.applied);
  const conflict = results.find((result) => !result.applied);
  assert.equal(applied.revision, 2);
  assert.equal(conflict.outcome, 'precondition_failed');
  assert.equal(conflict.currentVersionEtag, applied.versionEtag);
  const replayRequest = conflict === results[0] ? firstRequest : secondRequest;
  const replay = await service.updateFile(replayRequest);
  assert.equal(replay.receiptCreated, false);
  assert.equal(replay.currentVersionEtag, conflict.currentVersionEtag);
  const winnerBytes = applied === results[0] ? firstBytes : secondBytes;
  assert.ok((await service.readContent({ ownerToken, fileId: initial.fileId })).bytes.equals(winnerBytes));
  const changedUpload = replayRequest === firstRequest ? secondUpload : firstUpload;
  assert.notEqual(changedUpload, replayRequest.request.uploadId);
  await assert.rejects(service.updateFile({
    ...replayRequest,
    request: { uploadId: changedUpload },
  }), RequestConflictError);
  const stats = await repository.stats();
  assert.equal(stats.versions, 2);
  assert.deepEqual(stats.mutations, { applied: 2, precondition_failed: 1 });
  assert.equal(stats.changes, 2);
});

test('concurrent independent creates allocate one contiguous committed account prefix', async () => {
  const count = 20;
  const uploads = [];
  for (let index = 0; index < count; index += 1) {
    uploads.push(await finalizedUpload(Buffer.from(`file-${String(index).padStart(2, '0')}`)));
  }
  const created = await Promise.all(uploads.map((uploadId, index) => service.createFile({
    ownerToken,
    idempotencyKey: `prefix-create-key-${String(index).padStart(4, '0')}`,
    request: { name: `File-${String(index).padStart(2, '0')}.txt`, uploadId },
  })));
  assert.deepEqual(created.map((result) => result.revision).sort((a, b) => a - b),
    Array.from({ length: count }, (_, index) => index + 1));
  const revisions = await pool.query('SELECT revision FROM account_changes ORDER BY revision');
  assert.deepEqual(revisions.rows.map((row) => Number(row.revision)), Array.from({ length: count }, (_, index) => index + 1));
  assert.equal((await repository.stats()).changes, count);
});

test('page chain freezes its upper revision and final checkpoint starts later history', async () => {
  await createdFile(Buffer.from('one'), 'One.txt', 'page-create-key-0001');
  await createdFile(Buffer.from('two'), 'Two.txt', 'page-create-key-0002');
  const start = await service.createStartToken({ ownerToken, request: { position: 'beginning' } });
  const first = await service.listChanges({ ownerToken, pageToken: start.pageToken, limit: 1 });
  assert.deepEqual(first.changes.map((change) => change.revision), [1]);
  await createdFile(Buffer.from('three'), 'Three.txt', 'page-create-key-0003');
  const second = await service.listChanges({ ownerToken, pageToken: first.nextPageToken, limit: 1 });
  assert.deepEqual(second.changes.map((change) => change.revision), [2]);
  assert.equal(second.nextPageToken, null);
  const later = await service.listChanges({ ownerToken, pageToken: second.newStartPageToken, limit: 10 });
  assert.deepEqual(later.changes.map((change) => change.revision), [3]);
  await assert.rejects(service.listChanges({ ownerToken: otherOwnerToken, pageToken: start.pageToken, limit: 1 }), ValidationError);
  const changed = `${start.pageToken.slice(0, -1)}${start.pageToken.at(-1) === 'A' ? 'B' : 'A'}`;
  await assert.rejects(service.listChanges({ ownerToken, pageToken: changed, limit: 1 }), ValidationError);
});

test('stale delete consumes no revision while committed tombstone denies metadata and bytes', async () => {
  const created = await createdFile(Buffer.from('delete me'), 'Delete.txt', 'delete-create-key-0001');
  const stale = await service.deleteFile({
    ownerToken,
    fileId: created.fileId,
    idempotencyKey: 'stale-delete-key-0001',
    ifMatch: `"00000000-0000-4000-8000-000000000099"`,
  });
  assert.equal(stale.outcome, 'precondition_failed');
  assert.equal(stale.revision, null);
  const deleted = await service.deleteFile({
    ownerToken,
    fileId: created.fileId,
    idempotencyKey: 'delete-file-key-0001',
    ifMatch: created.versionEtag,
  });
  assert.equal(deleted.applied, true);
  assert.equal(deleted.revision, 2);
  const replay = await service.deleteFile({
    ownerToken,
    fileId: created.fileId,
    idempotencyKey: 'delete-file-key-0001',
    ifMatch: created.versionEtag,
  });
  assert.equal(replay.receiptCreated, false);
  await assert.rejects(service.readFile({ ownerToken, fileId: created.fileId }), GoneError);
  await assert.rejects(service.readContent({ ownerToken, fileId: created.fileId }), GoneError);
  const start = await service.createStartToken({ ownerToken, request: { position: 'beginning' } });
  const page = await service.listChanges({ ownerToken, pageToken: start.pageToken, limit: 10 });
  assert.deepEqual(page.changes.map((change) => [change.revision, change.kind]), [[1, 'created'], [2, 'deleted']]);
  assert.equal(page.changes[1].versionEtag, null);
});

test('missing current object fails closed without substituting another version', async () => {
  const created = await createdFile(Buffer.from('missing object'), 'Missing.txt', 'missing-create-key-0001');
  const selected = await pool.query('SELECT blob_sha256 FROM file_versions WHERE id = $1', [created.versionEtag.slice(1, -1)]);
  const digest = selected.rows[0].blob_sha256;
  await unlink(join(objectRoot, 'objects', digest.slice(0, 2), digest));
  await assert.rejects(service.readContent({ ownerToken, fileId: created.fileId }), IntegrityError);
  assert.equal((await service.readFile({ ownerToken, fileId: created.fileId })).etag, created.versionEtag);
});
