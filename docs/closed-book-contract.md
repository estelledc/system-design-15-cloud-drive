# Closed-book contract: committed cloud-drive sync

## Reading boundary

This contract was written from the case title alone, before reading the fixed `system-design-notes` chapter. Product names below
identify only the problem family. Scale numbers, API shapes, state machines, and design choices are explicit hypotheses for this
lab, not claims about Google Drive or any current service. Later research must record confirmations, conflicts, omissions, and
changes instead of silently rewriting this baseline.

## Users and core behavior

### Creator/device

1. An authenticated account opens a bounded upload intent for synthetic bytes with declared size and SHA-256.
2. A device resumes an interrupted upload from a server-committed offset and finalizes only after full-byte verification.
3. A device creates or updates a file at one parent/name using a stable mutation ID and the base file version it observed.
4. A device renames or deletes an entry through the same ordered mutation contract.
5. A device asks for changes after its last committed account cursor and follows pagination without skipping an intervening write.

### Reader/device

1. An authenticated account lists its current namespace or reads one current file version.
2. A reader downloads bytes only through metadata that currently authorizes one verified immutable blob.
3. A stale device learns about current changes and tombstones through the change feed; the server does not claim the device
   received, applied, persisted, displayed, or understood them.

### Operator

1. An operator can distinguish an incomplete upload, an orphan object, a committed mutation, a conflict, and a lagging cursor.
2. Recovery procedures never infer publication merely from the presence of bytes in object storage.

## Non-goals for v0.1

- copying a consumer drive UI, native filesystem watcher, desktop/mobile client, or online document editor;
- real user files, thumbnails, previews, search indexing, comments, presence, or collaborative text merge;
- public links, group sharing, inherited ACLs, external domains, or permission-notification workflows;
- deduplication claims across mutually untrusted accounts;
- parallel multipart/direct-to-cloud upload, CDN delivery, compression, delta encoding, or block-level binary sync;
- encryption/key management, malware scanning, moderation, copyright processing, legal retention, or physical erasure;
- multi-region metadata, replicated object durability, failover, backup/restore, disaster recovery, or production deployment;
- proving a device received, durably stored, locally applied, opened, rendered, or synchronized a change.

## Hypothetical scale envelope

The design conversation assumes, without claiming a real product workload:

- 1 million daily active accounts;
- 20 namespace mutations/account/day: 20 million/day, about 232/s average and 2,320/s at a 10× peak;
- 100 metadata reads or change-feed requests/account/day: 100 million/day, about 1,157/s average and 11,570/s peak;
- 2 new or changed files/account/day at an average 2 MiB: about 4 TiB/day of new logical bytes before replication;
- 30-day hot change history: 600 million mutation events before compaction or archival;
- a 10-minute offline interval at the peak rate can add about 1.4 million global mutations, which is why a global cursor would
  be a poor implementation boundary even though the lab may serialize only one account at a time.

These figures select failure modes and pagination bounds. They are not a capacity plan. The implementation will use tiny synthetic
limits and report raw benchmark inputs without extrapolating them.

## Authority and state model

PostgreSQL is the proposed namespace and cursor authority. An immutable content-addressed object adapter is the proposed byte
authority. An object name alone never authorizes a read.

Candidate records:

- `accounts`: identity fingerprint and next committed account revision;
- `nodes`: stable file/folder ID, parent, normalized name, kind, lifecycle, and current version;
- `file_versions`: immutable version ID, predecessor/base version, blob digest/size, and conflict relationship;
- `upload_sessions`: owner, stable request identity, declared length/digest, committed offset, and lifecycle;
- `upload_chunks`: offset, length, digest, immutable request binding, and commit receipt;
- `mutation_requests`: account + device operation ID, immutable intent digest, and exact durable result;
- `account_changes`: account revision, node, mutation kind, version/tombstone data, and commit time.

Candidate upload states:

```text
uploading -> finalized
     |
     +----> expired              (future cleanup state, not v0.1 behavior)
```

Candidate node states:

```text
active -> tombstoned
```

A rejected optimistic update is a durable conflict result or explicit precondition failure; it is not a hidden last-writer-wins
transition. Whether v0.1 creates a sibling version or requires the client to retry will be chosen after source and primary-spec
review, but silent overwrite is forbidden either way.

## Core invariants

1. **Stable intent.** Reusing an upload or mutation idempotency key with changed owner, target, base version, bytes, or operation
   conflicts; exact replay returns the original durable result.
2. **Complete bytes before reference.** A committed file version references one immutable object whose exact length and full
   SHA-256 were verified. Object creation may precede metadata and leave an orphan; metadata may not precede the object.
3. **Contiguous upload offset.** A successful chunk begins at the current committed offset and advances it by exactly its accepted
   length. An offset mismatch changes no upload metadata.
4. **No silent overwrite.** Updating or deleting a file is conditional on the base/current version observed by the caller. A stale
   base cannot replace or erase the current version while returning success.
5. **Atomic namespace mutation.** Current node state, immutable version/tombstone, idempotent result, account revision, and change
   row commit in one transaction or none do.
6. **Committed cursor prefix.** Revisions are assigned inside the mutation transaction under one account lock. If cursor `r` is
   visible, every successful account mutation through `r` is committed and queryable; rolled-back allocation creates no hole.
7. **Stable pagination.** A page freezes an upper committed revision. Following its cursor never absorbs later writes into that
   page sequence and never skips a revision in `(after, upper]`.
8. **Namespace identity.** Active siblings cannot share the same normalized name. Rename/move updates identity and change evidence
   atomically; a folder cannot become its own descendant if folders are included in the runnable slice.
9. **Tombstone before reclamation.** Delete commits a versioned tombstone and change event before any asynchronous byte cleanup.
   Old bytes remaining present do not make the node readable.
10. **Read-time authority.** Listing, file metadata, and downloads consult the current account/node/version relationship; a digest
    guessed from another account is not authorization.
11. **Bounded inputs and outputs.** Names, paths, file/chunk size, page size, cursor, request body, range, retries, and logs have
    explicit limits before resource work.
12. **Evidence separation.** `object_verified`, `mutation_committed`, `change_page_response`, and `server_bytes_written` are distinct.
    None implies remote receipt, local apply, cross-device convergence, screen display, human collaboration, or backup durability.

## Initial API sketch

Authenticated mutation routes:

- `POST /v1/uploads` with stable key and `{expectedBytes, expectedSha256}`;
- `HEAD /v1/uploads/{uploadId}` to read the committed offset;
- `PATCH /v1/uploads/{uploadId}` with stable chunk key and exact offset;
- `POST /v1/uploads/{uploadId}/finalize` to verify and bind the immutable blob;
- `POST /v1/files` to create one file from a finalized upload;
- `PUT /v1/files/{fileId}` with stable mutation key and `baseVersionId`;
- `POST /v1/files/{fileId}/move` or a smaller rename-only equivalent;
- `DELETE /v1/files/{fileId}` with `baseVersionId`.

Authenticated read routes:

- `GET /v1/changes?after=<revision>&limit=<n>&upper=<frozen revision>`;
- `GET /v1/files/{fileId}` for current metadata;
- `GET /v1/files/{fileId}/content` with at most one byte range.

Exact fields and status codes remain hypotheses until primary specifications are reviewed. Cursors are opaque externally even if
v0.1 encodes a bounded account revision internally.

## Failure matrix

| Failure window | Required result |
|---|---|
| two upload-open requests race with one stable key | one upload intent wins; exact replay converges; changed intent conflicts |
| chunk object is written, then process dies before offset commit | offset remains old; object is an orphan/reusable candidate, not accepted upload evidence |
| offset commits, then response is lost | `HEAD` exposes the new offset; exact chunk-key replay returns the original result |
| full size matches but full digest differs | finalization fails; no file version or mutation becomes visible |
| verified blob exists, then create/update dies before metadata commit | no namespace or change-feed entry appears; retry can reuse the object |
| two devices update one base version concurrently | at most one may replace the current version; the loser receives a durable conflict outcome |
| mutation commits, then response is lost | exact mutation replay returns the same node/version/revision without allocating another revision |
| a change page is read while a new mutation commits | the page remains bounded by its frozen upper revision; the later mutation appears in a later session |
| delete races with download authorization | any authority observation after tombstone commit denies; already in-flight/copied bytes are not revoked claims |
| immutable object is missing or corrupted | metadata/download fails closed with integrity evidence; another file is never substituted |

## Required executable evidence before v0.1 completion

1. A clean-room README, source comparison, requirements, architecture, API, operations, threat model, and ADR.
2. Deterministic tests for normalization, bounds, byte ranges, manifest/version identity, and exact request digests.
3. Generated/state-machine tests for mutation sequences and stable change pagination.
4. Real PostgreSQL tests for concurrent idempotency, contiguous revisions, stale-base conflicts, atomic version/change commits, and
   tombstone authorization.
5. Real filesystem tests for exclusive immutable install, concurrent equal writes, readback digest, and corruption/missing-object
   failure.
6. A true-process crash smoke covering lost chunk response, lost mutation response, restart, exact replay, frozen delta page, and
   tombstone denial, with a log scan for credentials, names, IDs, digests, bytes, and object paths.
7. A bounded benchmark with exact source/chunk/page sizes, PostgreSQL/runtime/filesystem versions, exclusions, and raw timings.
8. Node 22/24/26 public CI with PostgreSQL 17.6, pinned actions, dependency audit, no skipped tests, and exact commit/run receipts.

## Initial design choices to challenge after source review

- Does the chapter treat block storage, metadata, notification, and client sync as separate authorities, and where is their join?
- Is “delta sync” bound to a committed, paginated snapshot or merely described as sending changed blocks?
- How are simultaneous offline updates prevented from silently overwriting one another?
- Does a block checksum identify bytes, authorize metadata, or get incorrectly asked to do both?
- What happens between upload completion, metadata commit, notification, device receipt, and local filesystem apply?
- How are rename, move, delete, version history, sharing, and quota ordered with the change feed?
- Which scale and product numbers are historic, cited, internally reproducible, or silently assumed?

The implementation remains pending until this baseline is committed, the fixed source is inspected, primary specifications are
verified, and the smallest executable invariant is selected.
