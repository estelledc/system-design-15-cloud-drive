# Verification

## Current receipt

The identity-safe rewrite preserved every existing tree, message, and timestamp while mapping the five commits in order: `de5539dd4a3e9a7f043592a9073fec15889afe61` → `5daf68c31fdffc301fbd4e2014278558ed8d86c8`, `4ec0273a0e35e535e908571f90983bfba6b9e9ff` → `d3773a32b8285bb0c32cd9a49e3da0938f945634`, `ec7b475bacab787269746a85d443f9459df72d3f` → `a50125b5bd0eb79f3a9686a77b07a614f055b6b6`, `b6029a6ca58f02f8e5aa58c0b185fa0bc27272ae` → `0eadcf3547e8d6d0e38ea96114b89f7c0a963cc7`, and `6abc5d2fc058ce48afdc67de2ccc63ade4904d82` → `87703fdd05125e50fdb85ac5c6cb9feafedad417`.

Implementation commit `0eadcf3547e8d6d0e38ea96114b89f7c0a963cc7` is green in the tree-equivalent historical pre-rewrite GitHub Actions [run 32179087586](https://github.com/estelledc/system-design-15-cloud-drive/actions/runs/32179087586). The run remains bound to the old commit object and completed on
2026-08-19 CST with PostgreSQL 17.6 and exact Node releases 22.23.2, 24.19.0, and 26.7.0.

Current reachable `main` uses the repository owner's GitHub noreply identity. Rewritten baseline `87703fdd05125e50fdb85ac5c6cb9feafedad417` passed [CI run 32226161955](https://github.com/estelledc/system-design-15-cloud-drive/actions/runs/32226161955) on Node 22, 24, and 26 with PostgreSQL 17.6 and the full quality gate.

| Gate | Current status | Evidence boundary |
|---|---|---|
| repository/syntax | pass: 40 files, 20 JavaScript files, 12 Markdown files, 2 pinned actions | artifacts, parsing, links, pins, portable paths, vocabulary |
| pure/filesystem/HTTP tests | 18 passing, 0 failed, 0 skipped on every runtime | validation, cursor corpus, CAS concurrency/readback, service and HTTP contracts |
| PostgreSQL integration | 8 passing, 0 failed, 0 skipped on every runtime | real schema, transactions, row locks, concurrent outcomes |
| process smoke | pass on every runtime | real process death/restart, response-loss replay, frozen page, tombstone |
| dependency audit | `npm audit --audit-level=high`: 0 vulnerabilities | current npm advisory database only |
| bounded benchmark | completed on every runtime; raw values below | raw exact fixture/runtime observations only |

The first public implementation run at tree-equivalent commit `a50125b5bd0eb79f3a9686a77b07a614f055b6b6` is deliberately retained as
[red run 32178955866](https://github.com/estelledc/system-design-15-cloud-drive/actions/runs/32178955866). All three runtimes
proved seven of eight PostgreSQL tests and failed the changed-intent assertion. The test accidentally supplied the losing request's
original upload again, so no conflict was correct. Commit `0eadcf3547e8d6d0e38ea96114b89f7c0a963cc7` selects the other upload
and asserts the two IDs differ; no product behavior or acceptance criterion was weakened.

## Process and benchmark receipts

Every matrix smoke reported the same facts: both response-loss exits were `SIGKILL`; exact chunk replay returned `created=false`
with final committed offset 150,000; exact file-create replay returned `receiptCreated=false`; there were four committed revisions;
the frozen page excluded later revision 3 and its returned checkpoint included it; the stale outcome allocated no revision; the
range response was `206` with `server_bytes_written`; later tombstone reads were denied; and device receipt/apply, convergence,
and human-view claim counters were all zero.

The benchmark input was fixed at one 524,288-byte source, 64 sequential 8,192-byte chunks, 50 sequential 2,048-byte version
cycles, and 300 reads of one 51-row change page. These are raw hosted-runner observations, not capacity estimates:

| Node | PostgreSQL | upload chunks/s | finalize ms | version cycles/s | change rows/s |
|---|---:|---:|---:|---:|---:|
| 22.23.2 | 17.6 | 237.280 | 23.501 | 60.804 | 19213.718 |
| 24.19.0 | 17.6 | 250.489 | 18.469 | 75.335 | 21173.679 |
| 26.7.0 | 17.6 | 256.574 | 21.005 | 68.278 | 19946.078 |

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
