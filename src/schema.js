export const schemaSql = `
CREATE TABLE IF NOT EXISTS accounts (
  owner_fingerprint char(64) PRIMARY KEY,
  committed_revision bigint NOT NULL DEFAULT 0 CHECK (committed_revision >= 0),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id uuid PRIMARY KEY,
  owner_fingerprint char(64) NOT NULL REFERENCES accounts(owner_fingerprint),
  idempotency_key varchar(128) NOT NULL,
  request_digest char(64) NOT NULL,
  expected_bytes integer NOT NULL CHECK (expected_bytes BETWEEN 1 AND 1048576),
  expected_sha256 char(64) NOT NULL,
  committed_offset integer NOT NULL DEFAULT 0 CHECK (committed_offset >= 0 AND committed_offset <= expected_bytes),
  state varchar(16) NOT NULL CHECK (state IN ('uploading', 'finalized', 'consumed')),
  source_sha256 char(64),
  consumed_version_id uuid,
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  finalized_at_ms bigint,
  UNIQUE (owner_fingerprint, idempotency_key),
  CHECK ((state = 'uploading' AND source_sha256 IS NULL AND finalized_at_ms IS NULL AND consumed_version_id IS NULL)
      OR (state = 'finalized' AND source_sha256 IS NOT NULL AND finalized_at_ms IS NOT NULL AND consumed_version_id IS NULL)
      OR (state = 'consumed' AND source_sha256 IS NOT NULL AND finalized_at_ms IS NOT NULL AND consumed_version_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS upload_chunk_requests (
  upload_id uuid NOT NULL REFERENCES upload_sessions(id),
  idempotency_key varchar(128) NOT NULL,
  request_digest char(64) NOT NULL,
  start_offset integer NOT NULL CHECK (start_offset >= 0),
  byte_count integer NOT NULL CHECK (byte_count BETWEEN 1 AND 131072),
  chunk_sha256 char(64) NOT NULL,
  committed_offset integer NOT NULL CHECK (committed_offset = start_offset + byte_count),
  committed_at_ms bigint NOT NULL CHECK (committed_at_ms >= 0),
  PRIMARY KEY (upload_id, idempotency_key),
  UNIQUE (upload_id, start_offset)
);

CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY,
  owner_fingerprint char(64) NOT NULL REFERENCES accounts(owner_fingerprint),
  display_name varchar(128) NOT NULL,
  normalized_name varchar(128) NOT NULL,
  state varchar(16) NOT NULL CHECK (state IN ('active', 'tombstoned')),
  current_version_id uuid NOT NULL,
  created_revision bigint NOT NULL CHECK (created_revision > 0),
  updated_revision bigint NOT NULL CHECK (updated_revision >= created_revision),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms bigint NOT NULL CHECK (updated_at_ms >= 0),
  tombstoned_at_ms bigint,
  CHECK ((state = 'active' AND tombstoned_at_ms IS NULL)
      OR (state = 'tombstoned' AND tombstoned_at_ms IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS files_active_name_idx
  ON files (owner_fingerprint, normalized_name) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS file_versions (
  id uuid PRIMARY KEY,
  file_id uuid NOT NULL REFERENCES files(id),
  version_number integer NOT NULL CHECK (version_number > 0),
  predecessor_id uuid,
  blob_sha256 char(64) NOT NULL,
  byte_count integer NOT NULL CHECK (byte_count BETWEEN 1 AND 1048576),
  created_revision bigint NOT NULL CHECK (created_revision > 0),
  created_at_ms bigint NOT NULL CHECK (created_at_ms >= 0),
  UNIQUE (file_id, version_number),
  UNIQUE (file_id, created_revision)
);

CREATE TABLE IF NOT EXISTS mutation_requests (
  owner_fingerprint char(64) NOT NULL REFERENCES accounts(owner_fingerprint),
  idempotency_key varchar(128) NOT NULL,
  request_digest char(64) NOT NULL,
  mutation_kind varchar(16) NOT NULL CHECK (mutation_kind IN ('create', 'update', 'delete')),
  outcome varchar(32) NOT NULL CHECK (outcome IN ('applied', 'precondition_failed', 'namespace_conflict')),
  file_id uuid,
  version_id uuid,
  current_version_id uuid,
  revision bigint,
  recorded_at_ms bigint NOT NULL CHECK (recorded_at_ms >= 0),
  PRIMARY KEY (owner_fingerprint, idempotency_key),
  CHECK ((outcome = 'applied' AND file_id IS NOT NULL AND revision IS NOT NULL AND revision > 0)
      OR (outcome = 'precondition_failed' AND file_id IS NOT NULL AND current_version_id IS NOT NULL AND revision IS NULL)
      OR (outcome = 'namespace_conflict' AND file_id IS NULL AND version_id IS NULL
          AND current_version_id IS NULL AND revision IS NULL)),
  CHECK ((mutation_kind IN ('create', 'update') AND outcome = 'applied' AND version_id IS NOT NULL)
      OR (mutation_kind = 'delete' AND outcome = 'applied' AND version_id IS NULL)
      OR outcome <> 'applied')
);

CREATE TABLE IF NOT EXISTS account_changes (
  owner_fingerprint char(64) NOT NULL REFERENCES accounts(owner_fingerprint),
  revision bigint NOT NULL CHECK (revision > 0),
  file_id uuid NOT NULL REFERENCES files(id),
  change_kind varchar(16) NOT NULL CHECK (change_kind IN ('created', 'updated', 'deleted')),
  version_id uuid,
  display_name varchar(128) NOT NULL,
  byte_count integer,
  committed_at_ms bigint NOT NULL CHECK (committed_at_ms >= 0),
  PRIMARY KEY (owner_fingerprint, revision),
  CHECK ((change_kind IN ('created', 'updated') AND version_id IS NOT NULL AND byte_count > 0)
      OR (change_kind = 'deleted' AND version_id IS NULL AND byte_count IS NULL))
);

CREATE INDEX IF NOT EXISTS account_changes_file_idx
  ON account_changes (owner_fingerprint, file_id, revision);
`;
