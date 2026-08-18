import assert from 'node:assert/strict';
import test from 'node:test';
import { CloudDriveService } from '../../src/cloud-drive-service.js';
import { CursorCodec } from '../../src/cursor-codec.js';
import { ownerFingerprint, sha256 } from '../../src/crypto.js';

const ids = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
];
const ownerToken = 'service-owner-token-0001';

test('file creation binds owner, normalized name, upload, and stable request digest', async () => {
  let captured;
  const repository = {
    async createFile(input) {
      captured = input;
      return {
        receiptCreated: true,
        applied: true,
        outcome: 'applied',
        fileId: input.fileId,
        versionId: input.versionId,
        currentVersionId: null,
        revision: 1,
      };
    },
  };
  let index = 0;
  const service = new CloudDriveService(repository, new CursorCodec('service-cursor-secret-is-long-enough-001'), {
    now: () => 123,
    idFactory: () => ids[index++],
  });
  const result = await service.createFile({
    ownerToken,
    idempotencyKey: 'create-file-key-0001',
    request: { name: 'Report.txt', uploadId: ids[2] },
  });
  assert.equal(captured.ownerFingerprint, ownerFingerprint(ownerToken));
  assert.equal(captured.normalizedName, 'report.txt');
  assert.equal(captured.fileId, ids[0]);
  assert.equal(captured.versionId, ids[1]);
  assert.equal(result.versionEtag, `"${ids[1]}"`);
  assert.equal(result.evidence, 'mutation_committed');
  assert.ok(!JSON.stringify(captured).includes(ownerToken));
});

test('stale update exposes only the durable current ETag and no success claim', async () => {
  const repository = {
    async updateFile(input) {
      return {
        receiptCreated: true,
        applied: false,
        outcome: 'precondition_failed',
        fileId: input.fileId,
        versionId: null,
        currentVersionId: ids[1],
        revision: null,
      };
    },
  };
  const service = new CloudDriveService(repository, new CursorCodec('service-cursor-secret-is-long-enough-002'), {
    idFactory: () => ids[3],
  });
  const result = await service.updateFile({
    ownerToken,
    fileId: ids[0],
    idempotencyKey: 'update-file-key-0001',
    ifMatch: `"${ids[2]}"`,
    request: { uploadId: ids[3] },
  });
  assert.equal(result.applied, false);
  assert.equal(result.versionEtag, null);
  assert.equal(result.currentVersionEtag, `"${ids[1]}"`);
  assert.equal(result.evidence, 'precondition_failed');
});

test('a page token retains its frozen upper revision after later writes', async () => {
  let current = 2;
  const rows = [1, 2, 3].map((revision) => ({
    revision,
    fileId: ids[0],
    kind: revision === 3 ? 'deleted' : revision === 1 ? 'created' : 'updated',
    versionId: revision === 3 ? null : ids[revision],
    name: 'Report.txt',
    bytes: revision === 3 ? null : revision,
  }));
  const repository = {
    async currentRevision() { return current; },
    async listChanges({ afterRevision, upperRevision, limit }) {
      return { changes: rows.filter((row) => row.revision > afterRevision && row.revision <= upperRevision).slice(0, limit + 1) };
    },
  };
  const codec = new CursorCodec('service-cursor-secret-is-long-enough-003');
  const service = new CloudDriveService(repository, codec, { now: () => 100 });
  const start = await service.createStartToken({ ownerToken, request: { position: 'beginning' } });
  const first = await service.listChanges({ ownerToken, pageToken: start.pageToken, limit: 1 });
  assert.deepEqual(first.changes.map((change) => change.revision), [1]);
  current = 3;
  const second = await service.listChanges({ ownerToken, pageToken: first.nextPageToken, limit: 1 });
  assert.deepEqual(second.changes.map((change) => change.revision), [2]);
  assert.equal(second.nextPageToken, null);
  const later = await service.listChanges({ ownerToken, pageToken: second.newStartPageToken, limit: 10 });
  assert.deepEqual(later.changes.map((change) => change.revision), [3]);
});

test('content range result remains server-write evidence only', async () => {
  const repository = {
    async readContent() { return { bytes: Buffer.from('abcdef'), versionId: ids[1] }; },
  };
  const service = new CloudDriveService(repository, new CursorCodec('service-cursor-secret-is-long-enough-004'));
  const result = await service.readContent({ ownerToken, fileId: ids[0], range: 'bytes=2-4' });
  assert.equal(result.status, 206);
  assert.equal(result.bytes.toString(), 'cde');
  assert.equal(result.etag, `"${ids[1]}"`);
  assert.equal(result.evidence, 'server_bytes_written');
  assert.ok(!('deviceApplied' in result));
});

test('upload service hashes bytes and owner without exposing either', async () => {
  let captured;
  const repository = {
    async openUpload(input) {
      captured = input;
      return { created: true, upload: { id: input.uploadId, expectedBytes: input.expectedBytes, offset: 0, state: 'uploading' } };
    },
  };
  const service = new CloudDriveService(repository, new CursorCodec('service-cursor-secret-is-long-enough-005'), {
    idFactory: () => ids[0],
    now: () => 456,
  });
  const result = await service.openUpload({
    ownerToken,
    idempotencyKey: 'upload-service-key-0001',
    request: { expectedBytes: 7, expectedSha256: sha256('fixture') },
  });
  assert.equal(captured.ownerFingerprint, ownerFingerprint(ownerToken));
  assert.equal(result.evidence, 'upload_opened');
  assert.ok(!JSON.stringify(captured).includes(ownerToken));
});
