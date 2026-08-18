# Research log

## Evidence boundary

The secondary chapter is fixed at repository commit `9d8388721e7231442763ad37398b8d82224aa68f`, chapter tree
`7f76cdd926fff79503f5db341c34c72ad04e43bd`, and `Readme.md` blob
`49177aa63fe697027c4e1bb3fbac765403400fcc`. That tree has no detected license, so this repository contains only independent
analysis and implementation. It does not copy the chapter's prose, diagrams, images, or code.

Public standards and vendor documentation are used to check mechanisms. They do not make the future implementation a conforming
Google Drive, tus, S3, POSIX, or production storage service.

## Closed-book comparison

| Question | Closed-book decision | Fixed chapter | Result for v0.1 |
|---|---|---|---|
| product slice | bounded upload, immutable file version, stale-base conflict, committed change page, current-version read | upload/download, revisions, sync, sharing, notifications | keep the narrower upload-to-version-to-change-feed slice |
| byte identity | full declared size and SHA-256 before metadata can reference bytes | 4 MB hashed blocks, compression, encryption, S3 | use a whole-file digest and local immutable object; block delta remains unimplemented |
| conflict | base version is an explicit precondition; stale writes never silently replace current state | first processed version wins and both copies are shown | return a durable precondition-failed result; client-side merge is outside the lab |
| sync authority | account-scoped committed revision log with bounded snapshot pagination | notification/long polling plus an offline backup queue or cache | use a durable change log; notification is only a future wake-up hint |
| pagination | token fixes `upperRevision`; later mutations cannot enter the page chain | “get changes” has no cursor, order, page, tombstone, or replay contract | use signed opaque checkpoint/page tokens and deterministic chronological pages |
| namespace | stable file ID plus one bounded flat-root name | path-based namespace in prose, stable IDs in the schema diagram | keep stable ID and flat root; folders, moves, and sharing remain separate problems |
| evidence | server commit, page response, byte write, device receipt/apply, and human outcome are distinct | “sync” and “notify clients” are product-level verbs | keep narrow server-side receipts only |

## What the chapter contributes

- File bytes and metadata need separate storage/data paths, with immutable versions and an ordered block manifest.
- Large or interruption-prone files benefit from resumable upload rather than restarting at byte zero.
- Concurrent offline edits need an explicit conflict outcome; silently accepting both as the same current version is unsafe.
- Change notifications can wake online clients, while offline clients need a durable way to catch up.
- Account-scoped block deduplication avoids turning one account's file existence into another account's side channel.
- Revision retention, cold storage, metadata caching, replication, and sharding are cost/scale policies rather than substitutes for
  a correct commit boundary.

These are useful directions. v0.1 selects the file-version/change-log join instead of creating placeholder sharing, queue, cache,
block-delta, cold-tier, and multi-region components.

## Defects and missing contracts in the fixed chapter

1. **The stated storage total is not derivable.** Ten million daily users, two 500 KB uploads/day, and 10 GB free space imply
   about 10 TB/day of new logical bytes and 100 PB if those same ten million accounts each fill the quota. The stated 500 PB needs
   unstated registered-account, retention, replication, or revision assumptions.
2. **The average file undercuts the block argument.** A 500 KB average upload fits inside one stated 4 MB maximum block, so the
   listed average workload does not demonstrate bandwidth savings from block delta. Real distributions, edit locality, chunking,
   and manifest overhead are missing.
3. **Pending metadata can trigger an early notification.** The upload diagram stores metadata as `pending` and notifies a second
   client before file bytes are uploaded, then notifies again after `uploaded`. Without an event type and read gate, a wake-up can
   expose an incomplete entry or cause duplicate work.
4. **Storage callback is not a commit protocol.** Callback authenticity, stable upload/version identity, checksum, duplicate and
   out-of-order delivery, transaction/outbox boundary, retry, and reconciliation are unspecified.
5. **There is no durable change-log schema.** The download diagram asks the metadata database for changes, but the shown schema has
   no account cursor, ordered change row, tombstone, page boundary, or exact retry result. An “offline backup queue” and a cache are
   alternately described as the offline authority without retention or overflow rules.
6. **Conflict preservation has no identity.** “First processed wins” and “show both copies” do not define the observed base
   version, request identity, conflict version lineage, winner transaction, or what an exact response-loss retry returns.
7. **Hash, order, and completeness are conflated.** A block hash can identify bytes but does not authorize an account, prove the
   ordered file manifest is complete, or atomically select a current version. Collision handling, size binding, and manifest digest
   are absent.
8. **Compression, encryption, and deduplication are not composed.** File-type compression, block encryption, and hash dedup are
   listed independently without key scope, nonce/determinism, key rotation, plaintext/ciphertext hash choice, or leakage analysis.
9. **Path identity conflicts with rename.** The prose identifies entries by namespace plus relative path, while the diagram uses a
   stable file ID. Path identity alone makes rename/move and concurrent parent changes ambiguous; name normalization and active
   sibling uniqueness are also unspecified.
10. **Sharing is a requirement without an authorization model.** There is no ACL/principal table, permission version, inheritance,
    revocation read gate, link capability, or change-log interaction.
11. **Failure handling names failover but not correctness.** “Promote a slave,” reassign a block task, or fetch a cross-region
    replica leaves split brain, fencing, idempotency, RPO/RTO, delete replication, and stale metadata/object joins open.
12. **Historical product figures have no source binding.** They are not current requirements and are not used as facts by this
    repository.

## Primary-source corrections

### Resumable upload must query committed progress

Google Drive's official [upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads) separates session
creation, byte transfer, status query, and completion. It says clients should inspect the server response range rather than assume
all sent bytes arrived, and that an expired session must restart. The [tus 1.0.x protocol](https://tus.io/protocols/resumable-upload.html)
likewise defines offset discovery and rejects an offset mismatch without advancing state.

v0.1 uses a smaller sequential offset protocol with stable request keys and full-source SHA-256. It claims neither Drive nor tus
conformance and has no week-long session lifecycle.

### Lost-update prevention is a precondition, not a timestamp guess

[RFC 9110, Section 13.1.1](https://www.rfc-editor.org/rfc/rfc9110#section-13.1.1) requires strong comparison for `If-Match` and
describes state-changing preconditions as a way to prevent lost updates. A false precondition prevents the requested mutation and
can return `412 Precondition Failed`.

v0.1 exposes the immutable current version as a strong ETag. Update and delete require exact `If-Match`; the PostgreSQL transaction
still rechecks the current version under lock. A stable mutation key records the exact success or conflict outcome so response-loss
replay does not reinterpret history.

### A wake-up notification is not the change payload

Google Drive's official [push notification guide](https://developers.google.com/workspace/drive/api/guides/push) states that file
and change notification bodies are empty, message numbers increase but are not sequential, channels expire and can overlap during
renewal, and callers must fetch resource/change state separately.

The official [changes guide](https://developers.google.com/workspace/drive/api/guides/manage-changes) orders change entries from
oldest to newest and distinguishes a next-page token from the new checkpoint available after the final page. v0.1 adopts that
separation as an independent lab contract: no notification service is implemented, and signed tokens freeze one account revision
upper bound until the page chain ends.

### A database sequence is not a committed cursor

PostgreSQL 17 [sequence documentation](https://www.postgresql.org/docs/17/functions-sequence.html) says an allocated `nextval`
is not reclaimed after transaction abort and therefore cannot provide a gapless sequence. PostgreSQL 17
[row-lock documentation](https://www.postgresql.org/docs/17/explicit-locking.html#LOCKING-ROWS) says `FOR UPDATE` blocks competing
writers/lockers until transaction end and warns that consistent lock order is the main deadlock defense.

v0.1 serializes only one account row, increments its revision inside the same transaction as file/version/request/change rows, and
never uses a global sequence value as a committed prefix. This is an intentional per-account write bottleneck and correctness
oracle, not a sharded production design.

### Local immutable object evidence is narrow

Node 22.23.2 [`fs` documentation](https://nodejs.org/download/release/v22.23.2/docs/api/fs.html) warns against check-then-open
existence tests and defines exclusive `wx` creation. The local adapter installs a synced temporary inode under a digest-derived
name without overwriting, then verifies full digest on reuse and read.

That proves only the executed local filesystem behavior. It does not prove power-loss durability, network filesystem semantics,
replication, backup, S3 conditional writes, encryption, or physical deletion.

## Decisions after comparison

- Keep resumable transport chunks, but make the finalized whole-file digest the only byte identity referenced by a file version.
- Keep one flat root and content update/delete. Folder graphs, moves, sharing, notifications, block delta, dedup, and retention are
  deferred because none is required to prove the selected commit/cursor invariant.
- Use immutable versions and a mandatory strong `If-Match`; stale updates receive a durable `412` result rather than an automatic
  server-side merge or silent last-write-wins.
- Lock account before file/upload, allocate a revision only for successful namespace mutations, and commit version/current pointer,
  idempotent result, and change row together.
- Use HMAC-signed opaque tokens. A checkpoint fixes the prior revision; the first page captures the current upper revision; all
  later pages retain that upper bound; only the last page returns the next checkpoint.
- Treat object presence as reusable storage work, never namespace publication. Missing/corrupt current objects fail closed.
- Call a successful response callback `server_bytes_written`; never device receipt, local apply, cross-device convergence, or a
  human-visible sync.

## Remaining unknowns

- Production chunking/delta algorithms, encrypted dedup scope, key rotation, and large-file multipart reconciliation.
- Folder DAG/cycle rules, Unicode name normalization, case sensitivity, rename/move conflicts, and platform filesystem projection.
- Sharing principals, inherited permissions, link capabilities, revocation delay, and shared-drive change ownership.
- Cursor retention/compaction, long-offline resnapshot, notification delivery, client local transactions, and conflict UI/merge.
- Replicated object durability, database failover, backup/restore, disaster recovery, legal deletion, and production capacity.
