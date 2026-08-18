# Requirements and invariants

## Goal

Build one executable cloud-drive core in which an authenticated account can resume an upload, create immutable file versions,
reject stale overwrites, pull a stable committed change history, and read only the currently authorized bytes.

The acceptance target is deliberately narrower than “design Google Drive.” The lab has no device agent and cannot prove that a
remote device received, persisted, applied, displayed, or converged on a change.

## Supported behavior

An account can:

- open and resume one sequential upload with declared byte length and SHA-256;
- finalize only a complete, digest-matching source;
- create one file in a flat private root from a finalized upload;
- replace content only when `If-Match` names the current immutable version;
- delete only when `If-Match` names the current immutable version;
- replay an exact upload/chunk/mutation request after response loss;
- read current metadata or one full/single-range content response;
- start at the beginning or current end of its change history and consume a frozen page chain.

The runnable implementation uses only synthetic files. Folder graphs, rename/move, sharing, notifications, and client-side apply
are excluded.

## Bounded contract

| Input or output | v0.1 bound |
|---|---:|
| source object | 1–1,048,576 bytes |
| upload chunk | 1–131,072 bytes |
| file name | 1–128 UTF-8 bytes, portable ASCII grammar |
| active namespace | one case-insensitive flat root per account |
| idempotency key | 16–128 characters from a restricted ASCII alphabet |
| bearer/owner token | 16–256 characters; only its fingerprint is persisted |
| JSON request body | 2,048 bytes at the HTTP boundary |
| change page | 1–100 rows |
| byte range | zero or one RFC-style `bytes` range |
| cursor token | 40–1,024 characters; canonical base64url payload and HMAC |

These limits make resource use testable; they are not product recommendations.

## State machines

Upload lifecycle:

```text
uploading --complete coverage + full digest--> finalized --successful mutation--> consumed
```

- Only `uploading` accepts a new chunk.
- Finalization is idempotent once the upload is `finalized` or `consumed`.
- A finalized upload can create exactly one immutable version.
- Expiry and garbage collection are operational debt, not hidden states.

File lifecycle:

```text
absent --create--> active --matching update--> active --matching delete--> tombstoned
```

- Every create/update selects a new immutable version ID.
- A tombstoned file retains history but is denied by current metadata and content reads.
- A stale update/delete records `precondition_failed`, consumes no account revision, and changes no file.

## Correctness invariants

### R1. Stable request identity

An idempotency key binds the owner and complete normalized intent. Exact replay returns the original result. Reuse with a changed
size, digest, offset, bytes, operation, target, base version, name, or upload conflicts.

### R2. Contiguous upload acknowledgement

A newly accepted chunk starts at the locked committed offset and advances it by exactly its length. Competing writes at the same
offset cannot both advance state. Presence of a chunk object alone is not acceptance evidence.

### R3. Complete bytes before version reference

Finalization rereads all accepted chunks in offset order, checks contiguous coverage, verifies declared whole-source SHA-256, and
installs the immutable whole object. A file version can consume only a finalized, same-owner upload whose object still verifies.

### R4. Immutable current-version precondition

The current version ID is a strong ETag. Update and delete compare `If-Match` again under the account/file locks. A stale base
returns a durable `412` outcome with the current ETag and cannot silently replace or erase the winner.

### R5. Atomic mutation/change join

For a successful create/update/delete, file state, immutable version or tombstone, upload consumption, durable mutation result,
account revision, and change row commit in one PostgreSQL transaction or none do.

### R6. Gapless committed account prefix

The account row is locked first. Its revision is incremented inside the successful mutation transaction, not with `nextval`.
Therefore visible account revision `r` means every successful mutation `1..r` is committed and queryable. Rejected or rolled-back
mutations allocate no revision.

### R7. Frozen change pages

A checkpoint identifies the last completely consumed revision. Its first request captures the current committed revision as the
page-chain upper bound. Every next-page token keeps that bound; later writes appear only after the final page returns a new
checkpoint.

### R8. Owner and current-state authorization

Every repository lookup binds the owner fingerprint. Content reads first resolve an active current file/version, then verify that
exact object. A known digest, old version, other owner's ID, or physically present tombstoned object grants no read.

### R9. Fail closed on object drift

A missing, non-regular, oversized, wrong-length, or digest-mismatching current object fails with integrity/dependency evidence.
The service never substitutes another object or silently serves stale metadata.

### R10. Evidence names stop where observation stops

The implementation may emit `upload_opened`, `upload_chunk_committed`, `object_verified`, `mutation_committed`,
`precondition_failed`, `change_checkpoint_issued`, `change_page_response`, and `server_bytes_written`.

It may not emit device receipt, durable local apply, cross-device convergence, screen display, human collaboration, backup
durability, or production acceptance because no such observer exists in this lab.

## Availability and recovery requirements

- A process may die after a chunk transaction commits but before its response; exact replay must return the committed offset.
- A process may die after a file mutation commits but before its response; exact replay must return the same file/version/revision.
- A complete object written before a rolled-back metadata transaction may remain as an orphan, but it cannot become readable by
  namespace discovery alone.
- An in-progress response authorized before a tombstone cannot be revoked retroactively. Any later authorization observation must
  deny metadata and content.
- PostgreSQL unavailability or current-object corruption fails closed. No degraded last-write-wins or unchecked byte path exists.

## Explicit non-requirements

- consumer UI, desktop/mobile sync engine, filesystem watcher, local transaction journal, merge UI, or online document editing;
- folders, moves, rename, Unicode/platform name projection, shared drives, ACLs, public links, or revocation propagation;
- parallel multipart upload, direct cloud upload, content-defined chunking, block delta, compression, encryption, deduplication,
  quota, malware scanning, preview generation, or search;
- notifications, webhook delivery, offline retention policy, cursor compaction/resnapshot, or long-term version retention;
- replicated metadata/object storage, multi-region writes, fencing across primaries, backup/restore, disaster recovery, legal
  deletion, or physical reclamation;
- SLA, production throughput/cost/capacity, Google Drive compatibility, deployment, or external acceptance.

## Acceptance evidence

Completion requires:

1. pure/generated tests for exact validation, range semantics, signed cursor bounds, service intent binding, HTTP evidence, and
   immutable local-object readback;
2. real PostgreSQL concurrency tests for upload races, wrong digest, name conflict, stale update, gapless revisions, frozen pages,
   tombstone denial, and missing-object failure;
3. a true-process `SIGKILL` smoke for lost chunk and mutation responses plus exact replay;
4. a bounded benchmark that reports exact fixture/runtime values without extrapolation;
5. public Node 22/24/26 CI on PostgreSQL 17.6, pinned actions, dependency audit, and 0 skipped tests;
6. documentation that states what each receipt does and does not prove.
