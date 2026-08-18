import { randomUUID } from 'node:crypto';
import {
  formatVersionEtag,
  parseIfMatch,
  parseSingleByteRange,
  safeInteger,
  validateChunk,
  validateCreateIntent,
  validateOwnerToken,
  validateStableKey,
  validateStartTokenIntent,
  validateUpdateIntent,
  validateUploadIntent,
  validateUuid,
} from './contracts.js';
import { digestJson, ownerFingerprint, sha256 } from './crypto.js';

function publicMutation(result, evidence) {
  return {
    receiptCreated: result.receiptCreated,
    applied: result.applied,
    outcome: result.outcome,
    fileId: result.fileId,
    versionEtag: result.versionId ? formatVersionEtag(result.versionId) : null,
    currentVersionEtag: result.currentVersionId ? formatVersionEtag(result.currentVersionId) : null,
    revision: result.revision,
    evidence,
  };
}

export class CloudDriveService {
  constructor(repository, cursorCodec, {
    now = () => Date.now(),
    idFactory = () => randomUUID(),
  } = {}) {
    this.repository = repository;
    this.cursorCodec = cursorCodec;
    this.now = now;
    this.idFactory = idFactory;
  }

  #owner(token) {
    return ownerFingerprint(validateOwnerToken(token));
  }

  async openUpload({ ownerToken, idempotencyKey, request }) {
    const intent = validateUploadIntent(request);
    validateStableKey(idempotencyKey);
    const owner = this.#owner(ownerToken);
    const result = await this.repository.openUpload({
      uploadId: this.idFactory(),
      ownerFingerprint: owner,
      idempotencyKey,
      requestDigest: digestJson({ owner, ...intent }),
      ...intent,
      createdAtMs: this.now(),
    });
    return { ...result, evidence: 'upload_opened' };
  }

  async headUpload({ ownerToken, uploadId }) {
    return this.repository.headUpload({
      uploadId: validateUuid(uploadId, 'upload ID'),
      ownerFingerprint: this.#owner(ownerToken),
    });
  }

  async commitChunk({ ownerToken, uploadId, idempotencyKey, offset, bytes }) {
    validateUuid(uploadId, 'upload ID');
    validateStableKey(idempotencyKey);
    const chunk = validateChunk({ offset, bytes });
    const chunkSha256 = sha256(chunk.bytes);
    const result = await this.repository.commitChunk({
      uploadId,
      ownerFingerprint: this.#owner(ownerToken),
      idempotencyKey,
      requestDigest: digestJson({ offset: chunk.offset, bytes: chunk.bytes.length, sha256: chunkSha256 }),
      chunkSha256,
      ...chunk,
      committedAtMs: this.now(),
    });
    return { ...result, evidence: 'upload_chunk_committed' };
  }

  async finalizeUpload({ ownerToken, uploadId }) {
    const result = await this.repository.finalizeUpload({
      uploadId: validateUuid(uploadId, 'upload ID'),
      ownerFingerprint: this.#owner(ownerToken),
      finalizedAtMs: this.now(),
    });
    return { ...result, evidence: 'object_verified' };
  }

  async createFile({ ownerToken, idempotencyKey, request }) {
    validateStableKey(idempotencyKey);
    const intent = validateCreateIntent(request);
    const owner = this.#owner(ownerToken);
    const result = await this.repository.createFile({
      ownerFingerprint: owner,
      idempotencyKey,
      requestDigest: digestJson({ owner, kind: 'create', ...intent }),
      fileId: this.idFactory(),
      versionId: this.idFactory(),
      ...intent,
      recordedAtMs: this.now(),
    });
    return publicMutation(result, result.applied ? 'mutation_committed' : 'mutation_rejected');
  }

  async updateFile({ ownerToken, fileId, idempotencyKey, ifMatch, request }) {
    validateUuid(fileId, 'file ID');
    validateStableKey(idempotencyKey);
    const baseVersionId = parseIfMatch(ifMatch);
    const intent = validateUpdateIntent(request);
    const owner = this.#owner(ownerToken);
    const result = await this.repository.updateFile({
      ownerFingerprint: owner,
      idempotencyKey,
      requestDigest: digestJson({ owner, kind: 'update', fileId, baseVersionId, ...intent }),
      fileId,
      baseVersionId,
      versionId: this.idFactory(),
      ...intent,
      recordedAtMs: this.now(),
    });
    return publicMutation(result, result.applied ? 'mutation_committed' : 'precondition_failed');
  }

  async deleteFile({ ownerToken, fileId, idempotencyKey, ifMatch }) {
    validateUuid(fileId, 'file ID');
    validateStableKey(idempotencyKey);
    const baseVersionId = parseIfMatch(ifMatch);
    const owner = this.#owner(ownerToken);
    const result = await this.repository.deleteFile({
      ownerFingerprint: owner,
      idempotencyKey,
      requestDigest: digestJson({ owner, kind: 'delete', fileId, baseVersionId }),
      fileId,
      baseVersionId,
      recordedAtMs: this.now(),
    });
    return publicMutation(result, result.applied ? 'mutation_committed' : 'precondition_failed');
  }

  async readFile({ ownerToken, fileId }) {
    const result = await this.repository.readFile({
      ownerFingerprint: this.#owner(ownerToken),
      fileId: validateUuid(fileId, 'file ID'),
    });
    return {
      id: result.file.id,
      name: result.file.name,
      version: result.version.versionNumber,
      bytes: result.version.bytes,
      createdRevision: result.file.createdRevision,
      updatedRevision: result.file.updatedRevision,
      etag: formatVersionEtag(result.version.id),
      evidence: 'file_metadata_response',
    };
  }

  async readContent({ ownerToken, fileId, range }) {
    const result = await this.repository.readContent({
      ownerFingerprint: this.#owner(ownerToken),
      fileId: validateUuid(fileId, 'file ID'),
    });
    const selected = parseSingleByteRange(range, result.bytes.length);
    return {
      ...selected,
      bytes: result.bytes.subarray(selected.start, selected.end + 1),
      totalBytes: result.bytes.length,
      etag: formatVersionEtag(result.versionId),
      evidence: 'server_bytes_written',
    };
  }

  async createStartToken({ ownerToken, request }) {
    const intent = validateStartTokenIntent(request);
    const owner = this.#owner(ownerToken);
    const current = await this.repository.currentRevision({ ownerFingerprint: owner, createdAtMs: this.now() });
    const after = intent.position === 'beginning' ? 0 : current;
    return {
      pageToken: this.cursorCodec.checkpoint(owner, after),
      evidence: 'change_checkpoint_issued',
    };
  }

  async listChanges({ ownerToken, pageToken, limit }) {
    const owner = this.#owner(ownerToken);
    const decoded = this.cursorCodec.decode(pageToken, owner);
    const boundedLimit = safeInteger(limit, 'limit', { min: 1, max: 100 });
    const upperRevision = decoded.kind === 'checkpoint'
      ? await this.repository.currentRevision({ ownerFingerprint: owner, createdAtMs: this.now() })
      : decoded.upper;
    const page = await this.repository.listChanges({
      ownerFingerprint: owner,
      afterRevision: decoded.after,
      upperRevision,
      limit: boundedLimit,
      createdAtMs: this.now(),
    });
    const hasMore = page.changes.length > boundedLimit;
    const changes = page.changes.slice(0, boundedLimit);
    const after = changes.at(-1)?.revision ?? decoded.after;
    return {
      changes: changes.map((change) => ({
        revision: change.revision,
        fileId: change.fileId,
        kind: change.kind,
        name: change.name,
        bytes: change.bytes,
        versionEtag: change.versionId ? formatVersionEtag(change.versionId) : null,
      })),
      nextPageToken: hasMore ? this.cursorCodec.page(owner, after, upperRevision) : null,
      newStartPageToken: hasMore ? null : this.cursorCodec.checkpoint(owner, upperRevision),
      evidence: 'change_page_response',
    };
  }
}
