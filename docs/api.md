# HTTP API

## Protocol boundary

This is a small lab protocol, not a Google Drive or tus-compatible API. Every route except `/healthz` requires:

```http
Authorization: Bearer <configured-lab-token>
```

Mutation/open/chunk routes also require one `Idempotency-Key` of 16–128 restricted ASCII characters. JSON routes require
`Content-Type: application/json`. Unknown JSON fields, unexpected/repeated query parameters, non-empty bodies where none are
defined, ambiguous validators, and multiple ranges fail closed.

Every JSON/content response uses `Cache-Control: private, no-store`. Error bodies disclose only a stable code:

```json
{"error":"invalid_request"}
```

## Status and error vocabulary

| Status | Code or meaning |
|---:|---|
| 200 | replay, successful update/delete/read, or change page |
| 201 | newly opened upload, committed chunk/finalize, created file/token |
| 204 | upload offset returned by `HEAD` |
| 206 | one satisfiable content byte range |
| 400 | `invalid_request` |
| 401 | `unauthorized` |
| 404 | `not_found` |
| 409 | `idempotency_conflict`, `offset_conflict`, `state_conflict`, or durable namespace conflict |
| 410 | `gone` tombstoned file |
| 412 | durable `precondition_failed` mutation result |
| 416 | `range_not_satisfiable`, with `Content-Range: bytes */<length>` |
| 422 | `integrity_failed` |
| 503 | `dependency_unavailable` |

Unhandled internal errors are returned as `500 {"error":"internal_error"}`. Error messages and causes are not serialized.

## Uploads

### Open an upload

```http
POST /v1/uploads
Idempotency-Key: upload-attempt-0001
Content-Type: application/json

{"expectedBytes":11,"expectedSha256":"<64-lowercase-hex>"}
```

New intent: `201`. Exact replay: `200`. The same owner/key with changed intent: `409 idempotency_conflict`.

```json
{
  "created": true,
  "upload": {
    "id": "10000000-0000-4000-8000-000000000001",
    "expectedBytes": 11,
    "offset": 0,
    "state": "uploading"
  },
  "evidence": "upload_opened"
}
```

The response also includes `Upload-Offset`.

### Inspect committed offset

```http
HEAD /v1/uploads/{uploadId}
```

Returns `204` with `Upload-Length` and `Upload-Offset`, and no body. Sent bytes are not assumed committed; this route and exact
chunk replay expose server state.

### Commit the next chunk

```http
PATCH /v1/uploads/{uploadId}
Idempotency-Key: upload-chunk-0001
Content-Type: application/offset+octet-stream
Upload-Offset: 0

<1..131072 bytes>
```

New receipt: `201`; exact replay: `200`. The same key with changed offset/bytes conflicts. A different key at the wrong current
offset returns `409 offset_conflict` and does not advance the upload.

```json
{
  "created": true,
  "offset": 11,
  "bytes": 11,
  "evidence": "upload_chunk_committed"
}
```

### Finalize

```http
POST /v1/uploads/{uploadId}/finalize
Content-Length: 0
```

The server rereads accepted chunks, verifies coverage and full declared SHA-256, then installs/verifies one immutable object. New
finalization returns `201`; later finalization of the same upload returns `200 created=false`. A wrong digest returns `422` and
does not create a file-visible version.

## Files

### Create

```http
POST /v1/files
Idempotency-Key: create-file-0001
Content-Type: application/json

{"name":"Report.txt","uploadId":"10000000-0000-4000-8000-000000000001"}
```

An active name is unique case-insensitively in the owner's flat root. A successful new mutation returns `201`; exact replay
returns `200` with the same fields. A durable name collision returns `409` with `outcome=namespace_conflict` and no revision.

```json
{
  "receiptCreated": true,
  "applied": true,
  "outcome": "applied",
  "fileId": "20000000-0000-4000-8000-000000000001",
  "versionEtag": "\"30000000-0000-4000-8000-000000000001\"",
  "currentVersionEtag": null,
  "revision": 1,
  "evidence": "mutation_committed"
}
```

The version ETag is also returned in the `ETag` header.

### Replace current content

```http
PUT /v1/files/{fileId}
Idempotency-Key: update-file-0001
If-Match: "30000000-0000-4000-8000-000000000001"
Content-Type: application/json

{"uploadId":"10000000-0000-4000-8000-000000000002"}
```

Only one exact strong UUID ETag is accepted; wildcard, weak, list, and unquoted validators are invalid. Success returns `200` and
a new `versionEtag`. If the base is stale, the server records and returns `412`:

```json
{
  "receiptCreated": true,
  "applied": false,
  "outcome": "precondition_failed",
  "fileId": "20000000-0000-4000-8000-000000000001",
  "versionEtag": null,
  "currentVersionEtag": "\"30000000-0000-4000-8000-000000000009\"",
  "revision": null,
  "evidence": "precondition_failed"
}
```

Exact replay returns the same outcome with `receiptCreated=false`; it is not re-evaluated against newer state. The losing upload is
not consumed.

### Delete

```http
DELETE /v1/files/{fileId}
Idempotency-Key: delete-file-0001
If-Match: "30000000-0000-4000-8000-000000000009"
Content-Length: 0
```

Matching delete returns `200` with an applied mutation/revision. Stale delete returns the same durable `412` form as update. A
tombstoned file later returns `410` from metadata and content reads.

### Read current metadata

```http
GET /v1/files/{fileId}
```

```json
{
  "id": "20000000-0000-4000-8000-000000000001",
  "name": "Report.txt",
  "version": 2,
  "bytes": 11,
  "createdRevision": 1,
  "updatedRevision": 2,
  "etag": "\"30000000-0000-4000-8000-000000000009\"",
  "evidence": "file_metadata_response"
}
```

### Read current content

```http
GET /v1/files/{fileId}/content
Range: bytes=0-4
```

No range returns `200`; one satisfiable range returns `206`, `Accept-Ranges: bytes`, `Content-Range`, exact `Content-Length`, and
the current version `ETag`. Open-ended and suffix ranges are supported. Multiple ranges are rejected.

The callback evidence is `server_bytes_written`: it means the server handed those bytes to its response stream callback. It does
not mean the caller received, persisted, opened, or displayed them.

## Change history

### Create a checkpoint token

```http
POST /v1/change-tokens
Content-Type: application/json

{"position":"beginning"}
```

`position` is exactly `beginning` or `now`. The response is `201`:

```json
{"pageToken":"<opaque-signed-token>","evidence":"change_checkpoint_issued"}
```

- `beginning` sets `after=0`.
- `now` reads the current committed revision and starts after it.

### Consume a frozen page chain

```http
GET /v1/changes?pageToken=<url-encoded-token>&limit=25
```

Both query parameters are required exactly once; page size is 1–100. A non-final response includes `nextPageToken` and a null
`newStartPageToken`. A final response reverses that:

```json
{
  "changes": [
    {
      "revision": 1,
      "fileId": "20000000-0000-4000-8000-000000000001",
      "kind": "created",
      "name": "Report.txt",
      "bytes": 11,
      "versionEtag": "\"30000000-0000-4000-8000-000000000001\""
    }
  ],
  "nextPageToken": null,
  "newStartPageToken": "<opaque-signed-checkpoint>",
  "evidence": "change_page_response"
}
```

Delete changes have `bytes=null` and `versionEtag=null`. A token is bound to one owner, canonical encoding, purpose, supported
version, and valid `(after, upper)` bounds. Tampering or cross-owner reuse returns `400`.

## Health and observability

`GET /healthz` is unauthenticated and returns `200 {"ok":true}` after a PostgreSQL round trip. It does not verify every object,
prove readiness of an external load balancer, or report production durability.

Structured logs deliberately omit credentials, owner/resource IDs, names, request keys, digests, cursors, bodies, and paths.
They provide only bounded operation/status/count/evidence facts described in [operations](operations.md).
