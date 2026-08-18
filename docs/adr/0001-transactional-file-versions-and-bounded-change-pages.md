# ADR 0001: Transactional file versions and bounded change pages

- Status: accepted for v0.1
- Date: 2026-08-19

## Context

The fixed chapter contains the right component families—resumable upload, block/object storage, metadata, revisions,
notifications, and conflict copies—but does not define the transaction that makes a completed file version and its sync history
agree. It also has no cursor protocol for the “get changes” arrow in its download diagram.

The lab needs one runnable slice that can survive duplicate requests and process death without claiming a full storage product. A
block-delta implementation would add chunking, compression, encryption, deduplication, and manifest choices before proving the
more basic metadata/change-log invariant.

## Decision

### 1. PostgreSQL is the lifecycle and change authority

One account row contains `committed_revision`. Every successful create, update, or delete transaction locks the account first,
then any file and upload rows in a fixed order. It commits all of these effects together:

- immutable mutation-key/request-digest binding and exact result;
- immutable file-version row for create/update, or a tombstone for delete;
- current file pointer/lifecycle;
- account revision increment by exactly one;
- one change row at that revision;
- finalized upload consumption for create/update.

A stale `If-Match` result is recorded but consumes no revision and changes no file. PostgreSQL sequences remain suitable for opaque
row IDs but are not used as the committed change prefix.

### 2. Bytes complete before metadata references them

Uploads advance one contiguous committed offset. Finalization reads every referenced chunk, verifies coverage and the declared
whole-file SHA-256, and installs one immutable content-addressed source object. A file mutation can reference only a finalized,
same-owner, unconsumed upload and consumes it atomically with the version.

Chunk/source objects may be left orphaned by a crash or rejected mutation. That is explicit garbage-collection debt and safer
than a committed version pointing to absent bytes.

### 3. Versions are immutable and updates use a strong precondition

Each active file has one current immutable version ID exposed as a strong ETag. Update and delete require an exact `If-Match`.
Two concurrent writers from one base cannot both advance the file: the first locked transaction commits, and the second records a
precondition-failed result. Automatic binary merge and sibling publication are outside v0.1.

### 4. Change tokens bind one bounded snapshot

Tokens are canonical JSON plus HMAC-SHA-256 under a process secret and include token version, owner fingerprint, position, and
purpose. A checkpoint token contains the last fully consumed revision. Its first list request reads the account's current revision
as `upperRevision`. Any next-page token carries the same upper bound and the last returned revision.

Pages query only `(afterRevision, upperRevision]` in ascending order with a bounded limit. A later mutation cannot enter the page
chain. The final page returns a new checkpoint for `upperRevision`; intermediate pages return only a next-page token. Tokens from
another owner, changed bytes, unsupported versions, invalid bounds, or oversized input fail before a query.

### 5. The vertical slice is deliberately flat and pull-based

Files have stable IDs and one bounded ASCII name in a flat account root. v0.1 supports create, content update, delete, current
metadata/content read, and change pages. It has no folders, rename/move, sharing, notification service, block delta, deduplication,
cold tier, or background cleanup.

Clients poll the authoritative change log. A future notification may only wake polling; it cannot replace cursor history or prove
device application.

### 6. Delivery receipts stop at the server boundary

Content reads authorize the current active file/version before full verified object readback and support at most one byte range.
The response callback may emit `server_bytes_written`. No source event may claim device receipt, local persistence/apply,
cross-device convergence, screen display, collaboration, or a human outcome.

## Consequences

### Positive

- A file's visible current version and its change-feed entry cannot disagree after commit.
- Response-loss retry is deterministic for both successful and stale mutations.
- A page chain is stable under concurrent writes without holding a long database transaction.
- The object adapter and PostgreSQL authority have a clear join and a fail-closed missing-object path.
- The implementation is small enough for real PostgreSQL concurrency and process-crash tests.

### Costs and limits

- One hot account serializes all namespace mutations and can become a bottleneck.
- Whole-file upload/update wastes bandwidth for small edits and does not exercise the chapter's block-delta proposal.
- HMAC token rotation, expiry, retention compaction, resnapshot, and server-side cursor revocation are not implemented.
- Flat ASCII names avoid rather than solve folder graphs and cross-platform name semantics.
- Orphan bytes and tombstoned versions remain until a separately designed mark/sweep and retention policy exists.

## Rejected alternatives

### Notification queue as sync authority

Rejected because disconnects, expiry, overlap, duplicate hints, and queue retention would make client state depend on delivery
history. A notification can be useful only after a durable replayable change log exists.

### Global database sequence as cursor

Rejected because aborted sequence allocations create gaps and because one global order would couple unrelated accounts. A locked
per-account counter makes the tested prefix explicit.

### Last-write-wins by server arrival time

Rejected because it can return success while silently erasing an offline edit. Strong version preconditions make the conflict
observable and replayable.

### Full block delta, sharing, and folder model in v0.1

Rejected because each adds independent correctness and security contracts. They are named future seams, not placeholder code.
