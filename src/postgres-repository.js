import { sha256 } from './crypto.js';
import {
  AppError,
  DependencyError,
  GoneError,
  IntegrityError,
  NotFoundError,
  OffsetConflictError,
  RequestConflictError,
  StateConflictError,
  ValidationError,
} from './errors.js';
import { schemaSql } from './schema.js';

function dependencyFailure(error) {
  return error instanceof AppError ? error : new DependencyError('PostgreSQL operation failed', error);
}

function number(value) {
  return Number(value);
}

function publicUpload(row) {
  return {
    id: row.id,
    expectedBytes: number(row.expected_bytes),
    offset: number(row.committed_offset),
    state: row.state,
  };
}

function publicFile(row) {
  return {
    id: row.id,
    name: row.display_name,
    state: row.state,
    currentVersionId: row.current_version_id,
    createdRevision: number(row.created_revision),
    updatedRevision: number(row.updated_revision),
  };
}

function publicMutation(row, receiptCreated) {
  return {
    receiptCreated,
    applied: row.outcome === 'applied',
    outcome: row.outcome,
    kind: row.mutation_kind,
    fileId: row.file_id,
    versionId: row.version_id,
    currentVersionId: row.current_version_id,
    revision: row.revision === null ? null : number(row.revision),
  };
}

function publicChange(row) {
  return {
    revision: number(row.revision),
    fileId: row.file_id,
    kind: row.change_kind,
    versionId: row.version_id,
    name: row.display_name,
    bytes: row.byte_count === null ? null : number(row.byte_count),
  };
}

export class PostgresCloudDriveRepository {
  constructor(pool, objectStore) {
    this.pool = pool;
    this.objectStore = objectStore;
  }

  async migrate() {
    try {
      await this.objectStore.init();
      await this.pool.query(schemaSql);
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async health() {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async #connect() {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async #ensureAccount(client, ownerFingerprint, createdAtMs) {
    await client.query(
      `INSERT INTO accounts (owner_fingerprint, committed_revision, created_at_ms)
       VALUES ($1, 0, $2) ON CONFLICT (owner_fingerprint) DO NOTHING`,
      [ownerFingerprint, createdAtMs],
    );
  }

  #classifyUpload(row, requestDigest) {
    if (row.request_digest !== requestDigest) throw new RequestConflictError();
    return { created: false, upload: publicUpload(row) };
  }

  async #uploadAfterRace(ownerFingerprint, idempotencyKey, requestDigest) {
    try {
      const result = await this.pool.query(
        'SELECT * FROM upload_sessions WHERE owner_fingerprint = $1 AND idempotency_key = $2',
        [ownerFingerprint, idempotencyKey],
      );
      if (!result.rows[0]) throw new DependencyError();
      return this.#classifyUpload(result.rows[0], requestDigest);
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async openUpload(input) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      await this.#ensureAccount(client, input.ownerFingerprint, input.createdAtMs);
      const existing = await client.query(
        'SELECT * FROM upload_sessions WHERE owner_fingerprint = $1 AND idempotency_key = $2',
        [input.ownerFingerprint, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const result = this.#classifyUpload(existing.rows[0], input.requestDigest);
        await client.query('COMMIT');
        return result;
      }
      const inserted = await client.query(
        `INSERT INTO upload_sessions (
           id, owner_fingerprint, idempotency_key, request_digest, expected_bytes,
           expected_sha256, committed_offset, state, created_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, 0, 'uploading', $7) RETURNING *`,
        [
          input.uploadId,
          input.ownerFingerprint,
          input.idempotencyKey,
          input.requestDigest,
          input.expectedBytes,
          input.expectedSha256,
          input.createdAtMs,
        ],
      );
      await client.query('COMMIT');
      return { created: true, upload: publicUpload(inserted.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error?.code === '23505') {
        return this.#uploadAfterRace(input.ownerFingerprint, input.idempotencyKey, input.requestDigest);
      }
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async headUpload({ uploadId, ownerFingerprint }) {
    try {
      const selected = await this.pool.query(
        'SELECT * FROM upload_sessions WHERE id = $1 AND owner_fingerprint = $2',
        [uploadId, ownerFingerprint],
      );
      if (!selected.rows[0]) throw new NotFoundError();
      return publicUpload(selected.rows[0]);
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async commitChunk(input) {
    const object = await this.objectStore.put(input.bytes);
    if (object.digest !== input.chunkSha256) throw new IntegrityError();
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT * FROM upload_sessions
         WHERE id = $1 AND owner_fingerprint = $2 FOR UPDATE`,
        [input.uploadId, input.ownerFingerprint],
      );
      const upload = selected.rows[0];
      if (!upload) throw new NotFoundError();
      const existing = await client.query(
        'SELECT * FROM upload_chunk_requests WHERE upload_id = $1 AND idempotency_key = $2',
        [input.uploadId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_digest !== input.requestDigest) throw new RequestConflictError();
        await client.query('COMMIT');
        return {
          created: false,
          offset: number(existing.rows[0].committed_offset),
          bytes: number(existing.rows[0].byte_count),
        };
      }
      if (upload.state !== 'uploading') throw new StateConflictError();
      if (number(upload.committed_offset) !== input.offset) throw new OffsetConflictError();
      const nextOffset = input.offset + input.bytes.length;
      if (nextOffset > number(upload.expected_bytes)) throw new OffsetConflictError();
      await client.query(
        `INSERT INTO upload_chunk_requests (
           upload_id, idempotency_key, request_digest, start_offset,
           byte_count, chunk_sha256, committed_offset, committed_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.uploadId,
          input.idempotencyKey,
          input.requestDigest,
          input.offset,
          input.bytes.length,
          input.chunkSha256,
          nextOffset,
          input.committedAtMs,
        ],
      );
      await client.query(
        'UPDATE upload_sessions SET committed_offset = $2 WHERE id = $1',
        [input.uploadId, nextOffset],
      );
      await client.query('COMMIT');
      return { created: true, offset: nextOffset, bytes: input.bytes.length };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async finalizeUpload(input) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query(
        `SELECT * FROM upload_sessions
         WHERE id = $1 AND owner_fingerprint = $2 FOR UPDATE`,
        [input.uploadId, input.ownerFingerprint],
      );
      const upload = selected.rows[0];
      if (!upload) throw new NotFoundError();
      if (upload.state !== 'uploading') {
        await client.query('COMMIT');
        return { created: false, upload: publicUpload(upload) };
      }
      if (number(upload.committed_offset) !== number(upload.expected_bytes)) {
        throw new StateConflictError('Upload is incomplete');
      }
      const chunks = await client.query(
        `SELECT start_offset, byte_count, chunk_sha256
         FROM upload_chunk_requests WHERE upload_id = $1 ORDER BY start_offset`,
        [input.uploadId],
      );
      let cursor = 0;
      const buffers = [];
      for (const chunk of chunks.rows) {
        if (number(chunk.start_offset) !== cursor) throw new IntegrityError('Committed chunks are not contiguous');
        const bytes = await this.objectStore.read(chunk.chunk_sha256, number(chunk.byte_count));
        buffers.push(bytes);
        cursor += bytes.length;
      }
      if (cursor !== number(upload.expected_bytes)) throw new IntegrityError('Committed chunks do not cover the source');
      const source = Buffer.concat(buffers, cursor);
      if (sha256(source) !== upload.expected_sha256) throw new IntegrityError('Full source digest does not match intent');
      const stored = await this.objectStore.put(source);
      if (stored.digest !== upload.expected_sha256) throw new IntegrityError();
      await client.query(
        `UPDATE upload_sessions SET state = 'finalized', source_sha256 = $2, finalized_at_ms = $3
         WHERE id = $1 RETURNING *`,
        [input.uploadId, stored.digest, input.finalizedAtMs],
      );
      const updated = await client.query('SELECT * FROM upload_sessions WHERE id = $1', [input.uploadId]);
      await client.query('COMMIT');
      return { created: true, upload: publicUpload(updated.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async #lockAccount(client, ownerFingerprint, nowMs) {
    await this.#ensureAccount(client, ownerFingerprint, nowMs);
    const selected = await client.query(
      'SELECT * FROM accounts WHERE owner_fingerprint = $1 FOR UPDATE',
      [ownerFingerprint],
    );
    return selected.rows[0];
  }

  async #existingMutation(client, input) {
    const selected = await client.query(
      'SELECT * FROM mutation_requests WHERE owner_fingerprint = $1 AND idempotency_key = $2',
      [input.ownerFingerprint, input.idempotencyKey],
    );
    if (!selected.rows[0]) return null;
    if (selected.rows[0].request_digest !== input.requestDigest) throw new RequestConflictError();
    return publicMutation(selected.rows[0], false);
  }

  async #recordMutation(client, input) {
    const inserted = await client.query(
      `INSERT INTO mutation_requests (
         owner_fingerprint, idempotency_key, request_digest, mutation_kind, outcome,
         file_id, version_id, current_version_id, revision, recorded_at_ms
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        input.ownerFingerprint,
        input.idempotencyKey,
        input.requestDigest,
        input.kind,
        input.outcome,
        input.fileId ?? null,
        input.versionId ?? null,
        input.currentVersionId ?? null,
        input.revision ?? null,
        input.recordedAtMs,
      ],
    );
    return publicMutation(inserted.rows[0], true);
  }

  async #finalizedUpload(client, ownerFingerprint, uploadId) {
    const selected = await client.query(
      'SELECT * FROM upload_sessions WHERE id = $1 AND owner_fingerprint = $2 FOR UPDATE',
      [uploadId, ownerFingerprint],
    );
    const upload = selected.rows[0];
    if (!upload) throw new NotFoundError();
    if (upload.state !== 'finalized') throw new StateConflictError('Upload is not available for one file version');
    await this.objectStore.verify(upload.source_sha256, number(upload.expected_bytes));
    return upload;
  }

  async createFile(input) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const account = await this.#lockAccount(client, input.ownerFingerprint, input.recordedAtMs);
      const replay = await this.#existingMutation(client, input);
      if (replay) {
        await client.query('COMMIT');
        return replay;
      }
      const existingName = await client.query(
        `SELECT id FROM files
         WHERE owner_fingerprint = $1 AND normalized_name = $2 AND state = 'active'`,
        [input.ownerFingerprint, input.normalizedName],
      );
      if (existingName.rows[0]) {
        const conflict = await this.#recordMutation(client, {
          ...input,
          kind: 'create',
          outcome: 'namespace_conflict',
          fileId: null,
          versionId: null,
        });
        await client.query('COMMIT');
        return conflict;
      }
      const upload = await this.#finalizedUpload(client, input.ownerFingerprint, input.uploadId);
      const revision = number(account.committed_revision) + 1;
      await client.query(
        `INSERT INTO files (
           id, owner_fingerprint, display_name, normalized_name, state, current_version_id,
           created_revision, updated_revision, created_at_ms, updated_at_ms
         ) VALUES ($1, $2, $3, $4, 'active', $5, $6, $6, $7, $7)`,
        [
          input.fileId,
          input.ownerFingerprint,
          input.name,
          input.normalizedName,
          input.versionId,
          revision,
          input.recordedAtMs,
        ],
      );
      await client.query(
        `INSERT INTO file_versions (
           id, file_id, version_number, predecessor_id, blob_sha256,
           byte_count, created_revision, created_at_ms
         ) VALUES ($1, $2, 1, NULL, $3, $4, $5, $6)`,
        [input.versionId, input.fileId, upload.source_sha256, upload.expected_bytes, revision, input.recordedAtMs],
      );
      await client.query(
        `UPDATE upload_sessions SET state = 'consumed', consumed_version_id = $2 WHERE id = $1`,
        [input.uploadId, input.versionId],
      );
      await client.query(
        'UPDATE accounts SET committed_revision = $2 WHERE owner_fingerprint = $1',
        [input.ownerFingerprint, revision],
      );
      await client.query(
        `INSERT INTO account_changes (
           owner_fingerprint, revision, file_id, change_kind, version_id,
           display_name, byte_count, committed_at_ms
         ) VALUES ($1, $2, $3, 'created', $4, $5, $6, $7)`,
        [
          input.ownerFingerprint,
          revision,
          input.fileId,
          input.versionId,
          input.name,
          upload.expected_bytes,
          input.recordedAtMs,
        ],
      );
      const result = await this.#recordMutation(client, {
        ...input,
        kind: 'create',
        outcome: 'applied',
        revision,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async updateFile(input) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const account = await this.#lockAccount(client, input.ownerFingerprint, input.recordedAtMs);
      const replay = await this.#existingMutation(client, input);
      if (replay) {
        await client.query('COMMIT');
        return replay;
      }
      const selected = await client.query(
        'SELECT * FROM files WHERE id = $1 AND owner_fingerprint = $2 FOR UPDATE',
        [input.fileId, input.ownerFingerprint],
      );
      const file = selected.rows[0];
      if (!file) throw new NotFoundError();
      if (file.state === 'tombstoned') throw new GoneError();
      if (file.current_version_id !== input.baseVersionId) {
        const conflict = await this.#recordMutation(client, {
          ...input,
          kind: 'update',
          outcome: 'precondition_failed',
          versionId: null,
          currentVersionId: file.current_version_id,
        });
        await client.query('COMMIT');
        return conflict;
      }
      const upload = await this.#finalizedUpload(client, input.ownerFingerprint, input.uploadId);
      const current = await client.query('SELECT * FROM file_versions WHERE id = $1', [file.current_version_id]);
      if (!current.rows[0]) throw new IntegrityError('Current file version is missing');
      const revision = number(account.committed_revision) + 1;
      await client.query(
        `INSERT INTO file_versions (
           id, file_id, version_number, predecessor_id, blob_sha256,
           byte_count, created_revision, created_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          input.versionId,
          input.fileId,
          number(current.rows[0].version_number) + 1,
          file.current_version_id,
          upload.source_sha256,
          upload.expected_bytes,
          revision,
          input.recordedAtMs,
        ],
      );
      await client.query(
        `UPDATE files SET current_version_id = $2, updated_revision = $3, updated_at_ms = $4
         WHERE id = $1`,
        [input.fileId, input.versionId, revision, input.recordedAtMs],
      );
      await client.query(
        `UPDATE upload_sessions SET state = 'consumed', consumed_version_id = $2 WHERE id = $1`,
        [input.uploadId, input.versionId],
      );
      await client.query(
        'UPDATE accounts SET committed_revision = $2 WHERE owner_fingerprint = $1',
        [input.ownerFingerprint, revision],
      );
      await client.query(
        `INSERT INTO account_changes (
           owner_fingerprint, revision, file_id, change_kind, version_id,
           display_name, byte_count, committed_at_ms
         ) VALUES ($1, $2, $3, 'updated', $4, $5, $6, $7)`,
        [
          input.ownerFingerprint,
          revision,
          input.fileId,
          input.versionId,
          file.display_name,
          upload.expected_bytes,
          input.recordedAtMs,
        ],
      );
      const result = await this.#recordMutation(client, {
        ...input,
        kind: 'update',
        outcome: 'applied',
        revision,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async deleteFile(input) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const account = await this.#lockAccount(client, input.ownerFingerprint, input.recordedAtMs);
      const replay = await this.#existingMutation(client, input);
      if (replay) {
        await client.query('COMMIT');
        return replay;
      }
      const selected = await client.query(
        'SELECT * FROM files WHERE id = $1 AND owner_fingerprint = $2 FOR UPDATE',
        [input.fileId, input.ownerFingerprint],
      );
      const file = selected.rows[0];
      if (!file) throw new NotFoundError();
      if (file.state === 'tombstoned') throw new GoneError();
      if (file.current_version_id !== input.baseVersionId) {
        const conflict = await this.#recordMutation(client, {
          ...input,
          kind: 'delete',
          outcome: 'precondition_failed',
          currentVersionId: file.current_version_id,
        });
        await client.query('COMMIT');
        return conflict;
      }
      const revision = number(account.committed_revision) + 1;
      await client.query(
        `UPDATE files SET state = 'tombstoned', updated_revision = $2,
           updated_at_ms = $3, tombstoned_at_ms = $3 WHERE id = $1`,
        [input.fileId, revision, input.recordedAtMs],
      );
      await client.query(
        'UPDATE accounts SET committed_revision = $2 WHERE owner_fingerprint = $1',
        [input.ownerFingerprint, revision],
      );
      await client.query(
        `INSERT INTO account_changes (
           owner_fingerprint, revision, file_id, change_kind, version_id,
           display_name, byte_count, committed_at_ms
         ) VALUES ($1, $2, $3, 'deleted', NULL, $4, NULL, $5)`,
        [input.ownerFingerprint, revision, input.fileId, file.display_name, input.recordedAtMs],
      );
      const result = await this.#recordMutation(client, {
        ...input,
        kind: 'delete',
        outcome: 'applied',
        versionId: null,
        revision,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async readFile({ ownerFingerprint, fileId }) {
    try {
      const selected = await this.pool.query(
        `SELECT file.*, version.version_number, version.predecessor_id,
                version.byte_count, version.created_revision AS version_created_revision
         FROM files AS file
         LEFT JOIN file_versions AS version ON version.id = file.current_version_id
         WHERE file.id = $1 AND file.owner_fingerprint = $2`,
        [fileId, ownerFingerprint],
      );
      const row = selected.rows[0];
      if (!row) throw new NotFoundError();
      if (row.state === 'tombstoned') throw new GoneError();
      if (row.version_number === null) throw new IntegrityError('Current file version is missing');
      return {
        file: publicFile(row),
        version: {
          id: row.current_version_id,
          fileId: row.id,
          versionNumber: number(row.version_number),
          predecessorId: row.predecessor_id,
          bytes: number(row.byte_count),
          createdRevision: number(row.version_created_revision),
        },
      };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async readContent({ ownerFingerprint, fileId }) {
    try {
      const selected = await this.pool.query(
        `SELECT file.state, file.current_version_id, version.blob_sha256, version.byte_count
         FROM files AS file
         LEFT JOIN file_versions AS version ON version.id = file.current_version_id
         WHERE file.id = $1 AND file.owner_fingerprint = $2`,
        [fileId, ownerFingerprint],
      );
      const row = selected.rows[0];
      if (!row) throw new NotFoundError();
      if (row.state === 'tombstoned') throw new GoneError();
      if (!row.blob_sha256) throw new IntegrityError('Current file object metadata is missing');
      const bytes = await this.objectStore.read(row.blob_sha256, number(row.byte_count));
      return { bytes, versionId: row.current_version_id };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async currentRevision({ ownerFingerprint, createdAtMs }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      await this.#ensureAccount(client, ownerFingerprint, createdAtMs);
      const selected = await client.query(
        'SELECT committed_revision FROM accounts WHERE owner_fingerprint = $1',
        [ownerFingerprint],
      );
      await client.query('COMMIT');
      return number(selected.rows[0].committed_revision);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async listChanges({ ownerFingerprint, afterRevision, upperRevision, limit, createdAtMs }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      await this.#ensureAccount(client, ownerFingerprint, createdAtMs);
      const account = await client.query(
        'SELECT committed_revision FROM accounts WHERE owner_fingerprint = $1',
        [ownerFingerprint],
      );
      const currentRevision = number(account.rows[0].committed_revision);
      if (afterRevision > upperRevision || upperRevision > currentRevision) {
        throw new ValidationError('change token bounds exceed committed history');
      }
      const selected = await client.query(
        `SELECT * FROM account_changes
         WHERE owner_fingerprint = $1 AND revision > $2 AND revision <= $3
         ORDER BY revision LIMIT $4`,
        [ownerFingerprint, afterRevision, upperRevision, limit + 1],
      );
      await client.query('COMMIT');
      return { currentRevision, changes: selected.rows.map(publicChange) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async stats() {
    try {
      const [accounts, uploads, chunks, files, versions, mutations, changes] = await Promise.all([
        this.pool.query('SELECT count(*)::integer AS count FROM accounts'),
        this.pool.query('SELECT state, count(*)::integer AS count FROM upload_sessions GROUP BY state ORDER BY state'),
        this.pool.query('SELECT count(*)::integer AS count FROM upload_chunk_requests'),
        this.pool.query('SELECT state, count(*)::integer AS count FROM files GROUP BY state ORDER BY state'),
        this.pool.query('SELECT count(*)::integer AS count FROM file_versions'),
        this.pool.query('SELECT outcome, count(*)::integer AS count FROM mutation_requests GROUP BY outcome ORDER BY outcome'),
        this.pool.query('SELECT count(*)::integer AS count FROM account_changes'),
      ]);
      return {
        accounts: accounts.rows[0].count,
        uploads: Object.fromEntries(uploads.rows.map((row) => [row.state, row.count])),
        chunks: chunks.rows[0].count,
        files: Object.fromEntries(files.rows.map((row) => [row.state, row.count])),
        versions: versions.rows[0].count,
        mutations: Object.fromEntries(mutations.rows.map((row) => [row.outcome, row.count])),
        changes: changes.rows[0].count,
      };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }
}
