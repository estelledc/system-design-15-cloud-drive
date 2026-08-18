# Verification

## Current receipt

The implementation is locally complete but has not yet been pushed in this phase. The current local-only evidence is 18 passing,
0 failed, 0 skipped pure/filesystem/HTTP tests, JavaScript syntax checks, and a zero-exit `git diff --check`.

Real PostgreSQL concurrency, process-crash recovery, benchmark values, exact Node releases, and dependency audit are deliberately
listed as pending until the public GitHub Actions run exists. A source review or local mock cannot substitute for that result.

| Gate | Current status | Evidence boundary |
|---|---|---|
| repository/syntax | locally checked; final static receipt pending complete docs | files, parsing, links, pins, portable paths, vocabulary |
| pure/filesystem/HTTP tests | 18 passing, 0 failed, 0 skipped | validation, cursor corpus, CAS concurrency/readback, service and HTTP contracts |
| PostgreSQL integration | pending public CI | real schema, transactions, row locks, concurrent outcomes |
| process smoke | pending public CI | real process death/restart, response-loss replay, frozen page, tombstone |
| dependency audit | pending public CI | current npm advisory database only |
| bounded benchmark | pending public CI | raw exact fixture/runtime observations only |

This section will be replaced with immutable commit/run receipts and raw matrix output after CI is green. “Pending” is not a
pass claim.

## Full gate

```bash
npm ci --ignore-scripts
npm run check:ci
```

The full gate runs:

1. static repository policy, JavaScript syntax, local Markdown links, action pins, path/secret patterns, schema/evidence contracts;
2. 18 pure/generated/local-filesystem/HTTP tests;
3. `npm audit --audit-level=high`;
4. eight integration tests against a real disposable PostgreSQL schema;
5. a true-process `SIGKILL` smoke over loopback HTTP, PostgreSQL, and local immutable objects;
6. a bounded upload/version/change-page benchmark.

CI repeats the exact gate on Node 22, 24, and 26 with PostgreSQL 17.6. The three PostgreSQL programs each drop and recreate the
configured database's `public` schema.

## Executable counterexamples

The suite requires all of these to hold:

- 20 concurrent upload opens under one owner/key create one upload; changed intent conflicts.
- Two chunk keys racing at one offset cannot both advance it; exact winning-key replay returns the first result.
- Full length with a wrong declared digest creates no file, version, mutation, or change row.
- Case-equivalent same-name creates yield one file/revision and one durable namespace-conflict receipt.
- Two updates from the same strong ETag yield one new version/revision and one durable `412` result.
- 20 concurrent independent creates produce the exact committed revision set `1..20` without a sequence gap.
- A page chain whose upper bound is 2 excludes revision 3 even when revision 3 commits between pages; the returned final
  checkpoint then exposes revision 3.
- Cross-owner/tampered/noncanonical cursor tokens fail before history is returned.
- A stale delete consumes no revision; matching delete writes one tombstone, after which metadata and bytes return `410`.
- Removing the current object's bytes causes content read to fail integrity without changing metadata or substituting a version.
- Concurrent equal object installs converge on one verified regular file; external corruption and missing objects fail closed.
- Multiple/unsatisfiable ranges, weak/list `If-Match`, unknown fields, invalid names/offsets, and ambiguous query shapes are rejected.

## Process smoke target

The smoke performs this exact sequence with real child processes:

1. open a 150,000-byte synthetic upload;
2. commit its first chunk, then `SIGKILL` the API before the response;
3. restart and exactly replay the chunk, expecting `created=false` at offset 65,536;
4. complete/finalize the source;
5. create its file, then `SIGKILL` after the mutation transaction but before the response;
6. restart and replay, expecting the same file/version/revision and `receiptCreated=false`;
7. read a ten-byte `206` range and observe only `server_bytes_written`;
8. create a second file, freeze a one-row page chain at revision 2, then commit revision 3;
9. finish the frozen chain without revision 3, then observe revision 3 from the returned checkpoint;
10. record and replay a stale `412` without allocating a revision;
11. tombstone the first file and observe `410` from metadata and content;
12. inspect database counts and scan child logs for credentials, keys, names, IDs, ETags, cursor, digest, bytes marker, and path.

The eventual receipt must explicitly report zero device-receipt, device-apply, convergence, and human-view claims.

## Benchmark fixture

The bounded benchmark uses:

- one 524,288-byte deterministic source;
- 64 sequential 8,192-byte chunk commits and one full-source finalization;
- 50 sequential 2,048-byte upload/finalize/conditional-version cycles;
- 300 repeated reads of a 51-row change page;
- runner-local temporary filesystem and PostgreSQL 17.6.

It reports exact Node/PostgreSQL releases, chunks/second, finalization milliseconds, version cycles/second, and observed change
rows/second. It does not include WAN/TLS, remote object storage, device apply, concurrency across accounts, replication, failover,
or production traffic, and must not be extrapolated to capacity or SLA.

## What green will not prove

- Google Drive/tus compatibility, production file sizes, direct/multipart upload, block delta, compression, encryption, dedup,
  quota, previews, scanning, search, folders, rename/move, sharing, or collaborative editing;
- notification delivery, cursor expiry/retention/resnapshot, client receipt, durable device apply, local filesystem projection,
  conflict merge/UI, cross-device convergence, screen display, or human understanding;
- remote object semantics, power-loss durability, replication, database failover/fencing, backup/restore, disaster recovery, legal
  retention/erasure, or physical byte deletion;
- authentication/account correctness beyond the lab allowlist, internet security, privacy/compliance, deployment, uptime, SLA,
  production capacity/cost, review/merge/release, or external acceptance.

Green proves only the exercised boundaries on the exact commit and environments named by the final public receipt.
