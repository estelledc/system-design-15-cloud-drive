# Architecture

## One sentence

PostgreSQL owns which immutable version is current and which revisions are committed; the local content-addressed store owns only
verified bytes. A file becomes discoverable when one transaction joins those authorities, not when an object happens to exist.

## Component view

```text
authenticated caller
        |
        v
HTTP adapter ---- exact inputs, private/no-store, bounded receipts
        |
        v
CloudDriveService ---- owner fingerprint, stable intent digest, ETag/cursor rules
        |
        +-------------------------+
        v                         v
PostgreSQL repository       immutable object adapter
accounts                    objects/<sha-prefix>/<sha256>
uploads/chunk receipts      synced temporary file
files/versions              exclusive hard-link install
mutation receipts           full digest readback
account changes
```

The HTTP layer authenticates against a process-local lab allowlist. The service validates and derives opaque identities. The
repository enforces transaction/lock order. The object adapter cannot publish a file by itself.

## Data model

| Record | Authority |
|---|---|
| `accounts` | owner fingerprint and last committed account revision |
| `upload_sessions` | immutable upload intent, current offset, lifecycle, final source digest |
| `upload_chunk_requests` | stable chunk result and ordered byte evidence |
| `files` | stable file ID, flat-root name, active/tombstoned state, current version pointer |
| `file_versions` | immutable predecessor, object digest/length, version number, creation revision |
| `mutation_requests` | stable create/update/delete intent and exact applied/conflict outcome |
| `account_changes` | durable chronological account history keyed by `(owner, revision)` |

The schema intentionally does not foreign-key `files.current_version_id` to `file_versions.id`: the two rows form a creation
cycle. The repository creates the file and first version inside one transaction, and read paths fail closed if the join is absent.
That is a bounded implementation choice, not a claim that application-enforced integrity is generally preferable.

## Upload and finalization flow

```text
POST upload
  -> insert owner + immutable intent, or return exact existing intent

PATCH(offset, chunk)
  -> install immutable chunk object
  -> lock upload
  -> check stable key, state, exact committed offset, remaining length
  -> commit chunk receipt + new offset

POST finalize
  -> lock upload
  -> read chunk receipts in offset order
  -> verify every chunk digest and contiguous coverage
  -> verify declared whole-file digest
  -> install/verify immutable whole object
  -> mark upload finalized
```

Installing a chunk before its transaction is safe but may leave garbage: object presence is reusable storage work, not an
accepted offset. Finalization currently concatenates the bounded source in memory; the 1 MiB limit makes that explicit.

## Mutation transaction

Every create/update/delete uses the same lock order:

1. begin transaction and ensure the owner row exists;
2. lock the account row;
3. return an exact prior mutation result or reject changed intent;
4. inspect/lock the target file and finalized upload as applicable;
5. for update/delete, compare the strong base version under lock;
6. on stale base, record `precondition_failed` and commit without a revision;
7. on success, calculate `committed_revision + 1`;
8. write immutable version or tombstone, current state, upload consumption, account revision, change row, and mutation receipt;
9. commit once.

Account-first locking serializes all namespace writes for one account. It also makes same-name creates deterministic and prevents
two upload consumers or two writers from both succeeding. Different accounts do not share that lock.

## Why a PostgreSQL sequence is not the cursor

Sequence values are useful unique identifiers, but an allocated value is not rolled back with a failed transaction. Exposing it
as “all changes through N” would create unexplained holes. This lab instead increments the locked account row only inside the
mutation transaction. The cost is one hot-row bottleneck; the benefit is a directly testable committed prefix.

## Stable change pagination

Two signed token forms exist:

```text
checkpoint = {version, owner, kind=checkpoint, after}
page       = {version, owner, kind=page, after, upper}
```

The first read from a checkpoint captures current account revision `upper`. The query returns at most `limit + 1` rows from
`(after, upper]`; the extra row proves whether another page exists. Intermediate tokens retain the same `upper`. Only the final
page returns a new checkpoint at `upper`.

```text
checkpoint after=0
        |
        | current revision is 2
        v
page 1: revision 1, next(after=1, upper=2)
        |
        | revision 3 commits here
        v
page 2: revision 2, final checkpoint(after=2)
        |
        v
new session: revision 3
```

The HMAC detects token changes and binds the owner, shape, version, and bounds. It does not encrypt revision values, expire old
tokens, or solve key rotation/retention.

## Read path and tombstones

Metadata reads join the active file to exactly its current immutable version. Content reads perform the same current-state lookup,
then read and hash that object's bytes before producing a full or single-range response. All responses are `private, no-store`.

Delete keeps the historical current-version pointer but changes file state and writes a tombstone change. Later metadata/content
authorization returns `410` even while old bytes remain on disk. A response already authorized and streaming before commit is not
revoked; the lab claims only behavior at later authority observations.

## Failure windows

| Window | Durable result | Retry/observation |
|---|---|---|
| equal upload opens race | one insert | exact key converges; changed intent conflicts |
| chunk object exists, DB rolls back | orphan object | offset stays old; retry may reuse bytes |
| chunk DB commit, response lost | receipt + advanced offset | `HEAD` and exact replay expose committed offset |
| wrong full digest | upload remains uploading | no file/version/change exists |
| complete object exists, mutation rolls back | orphan/reusable object | no namespace visibility |
| two writers use one base | one applied, one durable stale outcome | one new revision only |
| mutation commits, response lost | exact mutation receipt | replay returns same file/version/revision |
| later write during page chain | later revision is above frozen upper | appears only from returned final checkpoint |
| current object missing/corrupt | metadata remains, content integrity error | no substitution or unchecked bytes |
| tombstone commits | file is denied | physical bytes may remain but are unauthorized |

## Security and privacy boundaries

- The bearer token is validated in memory; only a domain-separated SHA-256 fingerprint reaches PostgreSQL.
- Repository queries bind owner and resource; object digests are never public authorization capabilities.
- Structured logs contain operation, status, booleans, counts, and evidence labels—not tokens, owner/file IDs, names, request
  keys, digests, cursor tokens, bodies, or object paths.
- The local object root is private and uses regular-file, size, and digest checks. It is not a hardened hostile multi-user store.
- HMAC cursor integrity depends on a process secret; there is no key ID or rotation protocol in v0.1.

[Threat model](threat-model.md) covers the excluded production controls.

## Scaling seams, not implemented components

The correctness oracle will eventually bottleneck on a hot account, synchronous whole-object assembly, local disk, unbounded
history, and one database. Plausible next steps are account partitioning, streamed/cloud multipart finalization, retention-aware
cursor resnapshot, an outbox-fed wake-up service, and a client-side durable apply journal.

Each is a new contract. In particular:

- notifications must remain hints over a durable change authority;
- sharding must preserve one account's revision ownership during moves/failover;
- object replication must define read-after-write and delete/restore behavior;
- a device agent must add receipts for local apply before anyone can claim convergence;
- block delta must compose chunk identity, ordered manifest, encryption, dedup scope, and version commit.

They are intentionally absent rather than represented by inert queues, caches, or “future” interfaces.
