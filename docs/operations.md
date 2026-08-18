# Operations

## Local-only posture

This repository is a learning lab. Its authentication allowlist, local object store, single PostgreSQL database, destructive test
setup, absent retention, and absent backup make it unsuitable for internet exposure or real files.

Requirements:

- Node.js 22 or newer and npm;
- a disposable PostgreSQL 17.6 database;
- a private directory on a POSIX-like local filesystem.

Install and start the disposable database:

```bash
npm ci --ignore-scripts
docker compose up -d postgres
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/cloud_drive
```

Run the local-only gate:

```bash
npm run check
```

Run the full gate, including destructive PostgreSQL tests, process crashes, and the benchmark:

```bash
npm run check:ci
```

`test:postgres`, `smoke:postgres`, and `benchmark:postgres` each drop and recreate the configured database's `public` schema.
Never point them at a shared, persistent, staging, or production database.

## API configuration

```bash
export OBJECT_ROOT="$PWD/.local-cloud-drive-objects"
export AUTH_TOKENS_JSON='["replace-with-at-least-16-characters"]'
export CURSOR_SECRET='replace-with-at-least-32-characters'
export HOST=127.0.0.1
export PORT=3000
npm start
```

| Variable | Required/default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string |
| `OBJECT_ROOT` | required | private local immutable-object root |
| `AUTH_TOKENS_JSON` | required | JSON array of 1–100 lab bearer tokens |
| `CURSOR_SECRET` | required | 32–256 character HMAC secret |
| `HOST` | `127.0.0.1` | listen address |
| `PORT` | `3000` | non-negative integer; `0` selects an ephemeral port |
| `CLOCK_MS` | real clock | deterministic non-negative clock used only by tests/smoke |
| `CRASH_AFTER_CHUNK_COMMIT` | off | smoke-only `SIGKILL` after a new chunk commit |
| `CRASH_AFTER_MUTATION_COMMIT` | off | smoke-only `SIGKILL` after a new successful mutation commit |

Do not use deterministic clocks or crash switches in a hosted environment. Tokens/secrets are process configuration, not a
production identity or secret-management design.

## Health and shutdown

`GET /healthz` performs a PostgreSQL `SELECT 1`. It does not inspect object inventory, compare metadata to every object, validate
backup freshness, or prove write readiness after failover.

`SIGTERM`/`SIGINT` stops accepting new connections, closes the HTTP server, and then closes the pool. `SIGKILL` is intentionally
uncatchable and used to demonstrate response-loss recovery. There is no connection-drain timeout or orchestration lifecycle.

## Structured receipts

Logs are one JSON record per line. Allowed fields include event kind, operation, HTTP status, booleans, byte/count values, and the
bounded evidence label. They intentionally omit:

- bearer tokens and owner fingerprints;
- idempotency keys and cursor tokens;
- upload/file/version IDs;
- names, bodies, source markers, and object digests;
- database URLs and filesystem paths.

The process smoke scans its child-process records for those exact synthetic sensitive values. This is a regression check, not a
general secret detector.

Useful production-style metrics that are not implemented would include outcome counts, offset conflicts, finalize integrity
failures, stale preconditions, transaction latency, account-lock wait, page size/lag, object verification failures, PostgreSQL
pool saturation, orphan age/bytes, and tombstone retention. Metric labels must not contain owner, file name, ID, digest, or token.

## Recovery playbooks

### Caller lost an upload-chunk response

1. Do not assume the sent bytes committed.
2. `HEAD` the upload or exactly replay the same chunk key, offset, and bytes.
3. If the committed offset advanced, continue there.
4. If a changed intent was accidentally reused, stop on `idempotency_conflict`; do not generate a success locally.

### Caller lost a mutation response

1. Exactly replay the same idempotency key, operation, target, base ETag, upload, and body.
2. Treat the returned durable receipt as authoritative, including a prior `412` or namespace conflict.
3. Do not resubmit under a new key until the caller has intentionally chosen a new operation.

### Stale update/delete

1. Preserve the local candidate bytes; the server did not consume the losing upload.
2. Fetch current metadata and change history from the last completed checkpoint.
3. A real client would ask a user or deterministic merge policy to choose a new base. This lab has no merge/apply agent.
4. If retrying, use the new current ETag and a new idempotency key because the intent changed.

### Missing or corrupt current object

1. Stop serving that file; `integrity_failed` is the expected fail-closed result.
2. Preserve PostgreSQL and object evidence for diagnosis.
3. Do not repoint the file to an older or same-digest-looking object without a separately verified recovery transaction.
4. Restore/repair is intentionally absent; a production design needs versioned replicas, audit, and tested restore.

### Cursor rejected

1. Verify the token belongs to the same authenticated account and was not decoded/re-encoded by the client.
2. Use only `nextPageToken` within a page chain and save `newStartPageToken` only from its final page.
3. HMAC secret changes invalidate all tokens in v0.1. There is no key rotation/overlap mechanism.
4. Retention compaction is absent, so there is no resnapshot response contract yet.

## Storage lifecycle debt

Objects are immutable and never reclaimed by v0.1. Chunk races, failed finalization, unused finalized uploads, replaced versions,
and tombstones can all retain bytes. Safe collection would require:

1. a complete mark set from live uploads, retained versions, and recovery holds;
2. a snapshot/fence so concurrent mutations cannot make a swept object newly live;
3. retention/legal/backup policies and replica awareness;
4. deletion receipts and restore tests.

Deleting unreferenced-looking files with a shell scan is unsafe and unsupported.

## Benchmark interpretation

The benchmark runs one 524,288-byte synthetic source in 64 sequential 8,192-byte chunks, 50 sequential 2,048-byte version
cycles, and 300 repeated reads of a 51-row change page against runner-local PostgreSQL and disk. It reports raw rates/timings for
the exact run.

It does not model WAN/TLS, direct upload, concurrent accounts, hot-account contention, client apply, remote object storage,
replication, failover, backup, or production traffic. Never extrapolate its figures into SLA or capacity claims.

## Dependency and release posture

- `package-lock.json` is authoritative and CI installs with `npm ci --ignore-scripts`.
- `pg` is exactly pinned; GitHub Actions are pinned to full commit hashes.
- CI permissions are read-only and run on Node 22, 24, and 26 with PostgreSQL 17.6.
- `npm audit --audit-level=high` is one advisory check, not complete supply-chain assurance.
- There is no deployment workflow, release artifact, hosted endpoint, operational SLO, or external acceptance.
