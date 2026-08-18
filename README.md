# Committed Cloud Drive Sync Lab

An evidence-first cloud-drive practice that makes one invariant executable: a current file version, its immutable verified bytes,
its idempotent mutation receipt, and its account change revision become visible together—or none do.

An authenticated caller uploads bounded synthetic bytes through a resumable offset protocol, creates immutable file versions with
strong `If-Match`, and pulls HMAC-signed change pages whose upper revision remains frozen under concurrent writes. PostgreSQL is
the namespace/change authority; a private local content-addressed store is only byte authority. This is a learning repository,
not a production storage product or Google Drive clone.

## What is implemented

- idempotent upload creation bound to owner, declared length, and full SHA-256;
- sequential `HEAD`/`PATCH` offset recovery with exact chunk-key replay;
- immutable local content objects installed by synced temporary file and exclusive hard link;
- contiguous chunk readback plus declared whole-source digest verification before finalization;
- flat private account namespace with case-normalized active-name uniqueness;
- immutable file versions and mandatory strong ETag preconditions for update/delete;
- durable applied, namespace-conflict, and stale-precondition mutation receipts;
- one locked per-account committed revision updated atomically with file state and one change row;
- signed checkpoint/page tokens that freeze an upper revision until the page chain ends;
- current-version metadata/content reads with private caching, one bounded range, and digest readback;
- tombstone authorization that denies later metadata and bytes while retaining history;
- bounded structured receipts that omit credentials, names, keys, IDs, digests, cursors, bodies, and paths;
- process-death recovery after a chunk or file mutation commits but its HTTP response is lost.

The slice excludes folders, rename/move, sharing, notifications, client apply, conflict merge UI, block delta, compression,
encryption, deduplication, quota, malware scanning, remote object storage, replication, garbage collection, backup/restore,
multi-region operation, and high availability.

## Architecture in one view

```text
device-shaped HTTP caller          PostgreSQL authority             immutable local objects
          |                                  |                               |
          | open / HEAD / PATCH ------------>| lock offset + chunk receipt   |
          |                                  |<------ install by SHA-256 -----|
          | finalize ----------------------->| verify coverage + full digest  |
          |                                  |                               |
          | create/update/delete ---------->| account lock                   |
          |                                  | version/current/receipt/change |
          |                                  | commit together                |
          |                                  |                               |
          | checkpoint / page ------------->| query (after, frozen upper]    |
          | metadata / range -------------->| authorize current version -----> verified read
```

Object presence never publishes a file. A successful file transaction consumes one finalized upload, selects the new current
version, allocates the next account revision, and appends its change. A stale ETag records `412` but allocates no revision. See
[architecture](docs/architecture.md) for transaction order and failure windows.

## Run locally

Requirements: Node.js 22 or newer, npm, a disposable PostgreSQL 17.6 database, and a private directory on a POSIX-like local
filesystem.

```bash
npm ci --ignore-scripts
docker compose up -d postgres
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/cloud_drive
export OBJECT_ROOT="$PWD/.local-cloud-drive-objects"
export AUTH_TOKENS_JSON='["replace-with-at-least-16-characters"]'
export CURSOR_SECRET='replace-with-at-least-32-characters'
npm run check:ci
npm start
```

The PostgreSQL integration tests, smoke, and benchmark drop and recreate the configured database's `public` schema. Never point
them at a shared or production database, and never use real credentials or files.

## Verification boundary

`npm run check:ci` runs repository policy, 18 pure/generated/filesystem/HTTP tests, a dependency audit, eight real PostgreSQL
integration tests, a true-process `SIGKILL` smoke, and a bounded benchmark. Public CI executes the same gate on Node 22, 24, and
26 with PostgreSQL 17.6.

Passing proves only the exercised upload intent/offset, immutable-object, strong-precondition, transaction, committed-prefix,
frozen-page, range, and tombstone invariants. It does not prove remote device receipt, durable local apply, cross-device
convergence, human-visible sync, remote/power-loss durability, backup, production capacity, deployment, or external acceptance.
Exact current receipts live in [verification](docs/verification.md).

## Research provenance

The prompt source is chapter 15 of `liquidslr/system-design-notes`, fixed at commit
`9d8388721e7231442763ad37398b8d82224aa68f`. The snapshot has no detected license, so this repository follows a clean-room
boundary: the [closed-book contract](docs/closed-book-contract.md) was committed before source review, and no upstream prose,
diagram, image, or code is copied. The later [research log](docs/research-log.md) compares the chapter against primary Google Drive
upload/change/push, HTTP conditional, PostgreSQL lock/sequence, tus, and Node filesystem documentation.

## Documents

- [Requirements and invariants](docs/requirements.md)
- [Architecture and failure windows](docs/architecture.md)
- [HTTP API](docs/api.md)
- [Threat model](docs/threat-model.md)
- [Operations and recovery](docs/operations.md)
- [Verification receipts](docs/verification.md)
- [Closed-book contract](docs/closed-book-contract.md)
- [Research log](docs/research-log.md)
- [ADR 0001](docs/adr/0001-transactional-file-versions-and-bounded-change-pages.md)
- [Security policy](SECURITY.md)

Licensed under the [MIT License](LICENSE).
