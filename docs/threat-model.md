# Threat model

## Scope and assets

The lab protects only synthetic account namespace state, immutable synthetic bytes, mutation/change consistency, bearer/cursor
secrets in process memory, and bounded structured receipts.

The adversarial caller may send malformed or oversized requests, guess IDs/digests, replay or change stable keys, race offsets and
versions, tamper with cursor tokens, request ambiguous ranges, or use an authorized account token to access another account's ID.
Tests may also remove or corrupt an object and kill the API immediately after a database commit.

The model does not assume a hostile operating-system administrator, compromised application process, hostile PostgreSQL/object
store operator, or cryptographic break. It is not a production privacy/security assessment.

## Trust boundaries

```text
untrusted HTTP bytes
    | authentication + exact bounded parsing
    v
application process
    | parameterized SQL              | digest-derived private path
    v                                v
PostgreSQL authority             local filesystem objects
```

- The HTTP caller and all headers/bodies/tokens are untrusted.
- The application holds raw configured bearer tokens and the cursor HMAC secret.
- PostgreSQL is trusted to provide transaction/row-lock semantics, but may be unavailable.
- The private local object root is trusted against arbitrary writers in normal operation; readback still detects missing/wrong
  bytes and non-regular objects.
- Structured logs are a lower-trust observation sink and therefore receive no identities or content-derived values.

## Threats and current controls

### Cross-account object or metadata access

Risk: a caller guesses a file/upload UUID or a content digest from another account.

Controls:

- every repository resource lookup includes owner fingerprint;
- only the current active file/version authorizes content;
- no API reads by digest or historical version ID;
- a known filesystem object name is not an authorization capability;
- responses are private and non-cacheable.

Residual: process-local bearer allowlisting has no lifecycle, MFA, scopes, revocation service, session binding, or audit identity.

### Silent overwrite or delete

Risk: an offline/stale client replaces or erases a newer current version.

Controls:

- version UUID is exposed as a strong ETag;
- update/delete require exactly one strong `If-Match`;
- the current version is rechecked under account/file locks;
- a losing attempt records a durable `412` outcome and consumes no revision/upload.

Residual: there is no client merge, conflict-copy UX, folder/rename semantics, or malicious authorized-user protection.

### Replay and changed intent

Risk: retries duplicate revisions, or one stable key is reused to smuggle a different operation.

Controls:

- upload, chunk, and mutation keys bind a SHA-256 digest of the normalized complete intent;
- exact replay returns the stored result;
- changed intent returns `idempotency_conflict`;
- mutation receipt and state/change rows share a transaction.

Residual: keys never expire and there is no request signature, nonce ownership proof, or retention policy.

### Incomplete or substituted bytes

Risk: metadata points at a partial, missing, corrupted, or different object.

Controls:

- sequential offset/length receipts and final contiguous-coverage check;
- full declared source SHA-256 before finalization;
- immutable digest-derived install with exclusive hard link;
- digest/length verification on reuse, mutation consumption, and content read;
- current object failure returns integrity error instead of another version.

Residual: SHA-256 is used as byte identity, not encryption or authorization. There is no collision escalation protocol, remote
replication, power-loss proof, backup, malware scanning, content safety, or physical deletion.

### Cursor tampering, cross-owner replay, or skipped changes

Risk: a client changes cursor bounds, uses another account's token, or mixes later writes into a page chain.

Controls:

- canonical base64url payload plus HMAC-SHA-256;
- exact token shape/version/purpose/owner/bounds checks;
- frozen `upper` carried through all next-page tokens;
- chronological `(after, upper]` query over a gapless committed account prefix;
- only final page returns the next checkpoint.

Residual: token contents are integrity-protected but not encrypted. There is no expiry, key identifier/rotation overlap, retention
floor, server revocation, or resnapshot protocol.

### Resource exhaustion

Risk: large bodies, objects, chunks, pages, token inputs, repeated keys, or slow callers consume memory/CPU/database/disk.

Controls:

- explicit source/chunk/JSON/name/key/token/page/range limits;
- declared content length checked before body accumulation and streaming byte count checked during read;
- only one range and one flat namespace;
- parameterized bounded queries and a small connection pool default.

Residual: no request deadline, rate limit, quota, upload expiry, connection cap tuning, disk watermark, garbage collector, circuit
breaker, admission control, or abuse response. Finalization buffers the bounded full source in memory.

### Path traversal, links, and object overwrite

Risk: digest or user name escapes the object root, symbolic links redirect reads, or concurrent writers replace content.

Controls:

- object paths derive only from a validated lowercase 64-hex digest;
- user filenames never become filesystem paths;
- object read requires a regular non-symbolic file within the size bound;
- temp creation uses exclusive mode and target installation uses non-overwriting hard link;
- existing targets are fully verified.

Residual: the design assumes a private local root and POSIX-like link/fsync semantics. It is not safe on arbitrary network
filesystems or against a local actor that can replace directories between operations.

### Sensitive data in logs

Risk: credentials, names, IDs, cursors, digests, bytes, or paths leak through operational output.

Controls:

- explicit structured log calls expose only operation/status/boolean/count/evidence fields;
- application errors serialize stable codes, not causes;
- process smoke scans every child record for its synthetic sensitive values;
- repository policy rejects common private-key/GitHub-token forms and local absolute paths.

Residual: the scan covers chosen fixtures, not all secrets or dependency/runtime diagnostics. PostgreSQL and platform logs are
outside the application logger.

### Tombstone bypass and residual bytes

Risk: deleting metadata leaves bytes that remain readable or are incorrectly considered erased.

Controls:

- reads always consult active current state;
- delete, revision, tombstone change, and durable receipt commit together;
- later metadata/content observations return `410` regardless of physical object presence.

Residual: already in-flight or copied bytes cannot be revoked. Objects and versions are not physically reclaimed. There is no CDN,
client-cache, replica, backup, legal erasure, or purge-bound proof.

## Supply-chain posture

- one runtime dependency is exactly pinned in the lockfile;
- public CI installs from the lockfile with lifecycle scripts disabled;
- action references use full commit hashes and workflow permissions are read-only;
- high-severity npm advisory audit runs on every matrix job.

This does not prove registry integrity, maintainer trust, artifact provenance, dependency behavior, or absence of lower-severity or
unknown vulnerabilities.

## Production controls explicitly missing

Before any real deployment, the system would need an external identity/authorization model; tenant isolation; TLS and network
policy; secret rotation; encrypted storage/transport and key management; quota/rate limiting; malware/content controls; Unicode
and folder/share authorization; database HA/fencing/migrations; remote object durability; backup/restore/DR tests; retention and
erasure; notification/client apply protocol; observability/SLOs; incident response; dependency provenance; and independent
security/privacy review.
