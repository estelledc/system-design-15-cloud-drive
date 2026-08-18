import { createServer } from 'node:http';
import { MAX_CHUNK_BYTES, parseOffsetHeader, parsePageLimit } from './contracts.js';
import {
  AppError,
  AuthenticationError,
  NotFoundError,
  RangeNotSatisfiableError,
  ValidationError,
} from './errors.js';

function json(response, status, body, headers = {}) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'cache-control': 'private, no-store',
    'content-length': Buffer.byteLength(encoded),
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  });
  response.end(encoded);
}

async function readBody(request, maximumBytes) {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new ValidationError('request body is too large');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new ValidationError('request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

async function readJson(request, maximumBytes) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new ValidationError('content-type must be application/json');
  }
  const bytes = await readBody(request, maximumBytes);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ValidationError('request body is not valid JSON');
  }
}

function authenticate(request, authTokens) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw new AuthenticationError();
  const token = authorization.slice('Bearer '.length);
  if (!authTokens.has(token)) throw new AuthenticationError();
  return token;
}

function requireNoQuery(url) {
  if (url.search !== '') throw new ValidationError('query parameters are not supported');
}

function exactQuery(url, allowed) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new ValidationError('query parameters are invalid');
    }
  }
  for (const key of allowed) {
    if (!url.searchParams.has(key)) throw new ValidationError(`query parameter ${key} is required`);
  }
}

function matches(path, pattern) {
  return pattern.exec(path)?.groups;
}

function mutationStatus(result, { createdStatus = 200 } = {}) {
  if (result.outcome === 'precondition_failed') return 412;
  if (result.outcome === 'namespace_conflict') return 409;
  return result.receiptCreated ? createdStatus : 200;
}

function writeContent(response, result, logger) {
  const headers = {
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'content-length': result.length,
    'content-type': 'application/octet-stream',
    etag: result.etag,
  };
  if (result.status === 206) headers['content-range'] = `bytes ${result.start}-${result.end}/${result.totalBytes}`;
  response.writeHead(result.status, headers);
  response.end(result.bytes, () => logger({
    kind: 'server_bytes_written',
    status: result.status,
    bytes: result.bytes.length,
    evidence: result.evidence,
  }));
}

const uploadPath = /^\/v1\/uploads\/(?<uploadId>[0-9a-f-]{36})$/;
const finalizePath = /^\/v1\/uploads\/(?<uploadId>[0-9a-f-]{36})\/finalize$/;
const filePath = /^\/v1\/files\/(?<fileId>[0-9a-f-]{36})$/;
const contentPath = /^\/v1\/files\/(?<fileId>[0-9a-f-]{36})\/content$/;

export function createHttpServer({
  service,
  authTokens,
  health = async () => true,
  logger = () => {},
  afterChunkCommitted,
  afterMutationCommitted,
  maximumJsonBytes = 2_048,
  maximumChunkBytes = MAX_CHUNK_BYTES,
}) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        requireNoQuery(url);
        await health();
        json(response, 200, { ok: true });
        return;
      }

      const ownerToken = authenticate(request, authTokens);
      let match;
      if (request.method === 'POST' && url.pathname === '/v1/uploads') {
        requireNoQuery(url);
        const result = await service.openUpload({
          ownerToken,
          idempotencyKey: request.headers['idempotency-key'],
          request: await readJson(request, maximumJsonBytes),
        });
        logger({ kind: 'upload_opened', created: result.created, evidence: result.evidence });
        json(response, result.created ? 201 : 200, result, { 'upload-offset': result.upload.offset });
        return;
      }
      if (request.method === 'HEAD' && (match = matches(url.pathname, uploadPath))) {
        requireNoQuery(url);
        const upload = await service.headUpload({ ownerToken, ...match });
        response.writeHead(204, {
          'cache-control': 'private, no-store',
          'upload-length': upload.expectedBytes,
          'upload-offset': upload.offset,
        });
        response.end();
        return;
      }
      if (request.method === 'PATCH' && (match = matches(url.pathname, uploadPath))) {
        requireNoQuery(url);
        if (String(request.headers['content-type'] ?? '').toLowerCase() !== 'application/offset+octet-stream') {
          throw new ValidationError('content-type must be application/offset+octet-stream');
        }
        const result = await service.commitChunk({
          ownerToken,
          ...match,
          idempotencyKey: request.headers['idempotency-key'],
          offset: parseOffsetHeader(request.headers['upload-offset']),
          bytes: await readBody(request, maximumChunkBytes),
        });
        await afterChunkCommitted?.(result);
        logger({
          kind: 'upload_chunk_committed',
          created: result.created,
          bytes: result.bytes,
          offset: result.offset,
          evidence: result.evidence,
        });
        json(response, result.created ? 201 : 200, result, { 'upload-offset': result.offset });
        return;
      }
      if (request.method === 'POST' && (match = matches(url.pathname, finalizePath))) {
        requireNoQuery(url);
        const body = await readBody(request, 0);
        if (body.length !== 0) throw new ValidationError('finalize request must be empty');
        const result = await service.finalizeUpload({ ownerToken, ...match });
        logger({ kind: 'object_verified', created: result.created, evidence: result.evidence });
        json(response, result.created ? 201 : 200, result);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/files') {
        requireNoQuery(url);
        const result = await service.createFile({
          ownerToken,
          idempotencyKey: request.headers['idempotency-key'],
          request: await readJson(request, maximumJsonBytes),
        });
        if (result.receiptCreated && result.applied) await afterMutationCommitted?.({ kind: 'create', ...result });
        logger({
          kind: result.applied ? 'mutation_committed' : 'mutation_rejected',
          operation: 'create',
          receiptCreated: result.receiptCreated,
          outcome: result.outcome,
          evidence: result.evidence,
        });
        const headers = result.versionEtag ? { etag: result.versionEtag } : {};
        json(response, mutationStatus(result, { createdStatus: 201 }), result, headers);
        return;
      }
      if (request.method === 'PUT' && (match = matches(url.pathname, filePath))) {
        requireNoQuery(url);
        const result = await service.updateFile({
          ownerToken,
          ...match,
          idempotencyKey: request.headers['idempotency-key'],
          ifMatch: request.headers['if-match'],
          request: await readJson(request, maximumJsonBytes),
        });
        if (result.receiptCreated && result.applied) await afterMutationCommitted?.({ kind: 'update', ...result });
        logger({
          kind: result.applied ? 'mutation_committed' : 'precondition_failed',
          operation: 'update',
          receiptCreated: result.receiptCreated,
          outcome: result.outcome,
          evidence: result.evidence,
        });
        const headers = result.versionEtag || result.currentVersionEtag
          ? { etag: result.versionEtag ?? result.currentVersionEtag }
          : {};
        json(response, mutationStatus(result), result, headers);
        return;
      }
      if (request.method === 'DELETE' && (match = matches(url.pathname, filePath))) {
        requireNoQuery(url);
        const body = await readBody(request, 0);
        if (body.length !== 0) throw new ValidationError('delete request must be empty');
        const result = await service.deleteFile({
          ownerToken,
          ...match,
          idempotencyKey: request.headers['idempotency-key'],
          ifMatch: request.headers['if-match'],
        });
        if (result.receiptCreated && result.applied) await afterMutationCommitted?.({ kind: 'delete', ...result });
        logger({
          kind: result.applied ? 'mutation_committed' : 'precondition_failed',
          operation: 'delete',
          receiptCreated: result.receiptCreated,
          outcome: result.outcome,
          evidence: result.evidence,
        });
        const headers = result.currentVersionEtag ? { etag: result.currentVersionEtag } : {};
        json(response, mutationStatus(result), result, headers);
        return;
      }
      if (request.method === 'GET' && (match = matches(url.pathname, contentPath))) {
        requireNoQuery(url);
        const result = await service.readContent({ ownerToken, ...match, range: request.headers.range });
        writeContent(response, result, logger);
        return;
      }
      if (request.method === 'GET' && (match = matches(url.pathname, filePath))) {
        requireNoQuery(url);
        const result = await service.readFile({ ownerToken, ...match });
        logger({ kind: 'file_metadata_response', evidence: result.evidence });
        json(response, 200, result, { etag: result.etag });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/change-tokens') {
        requireNoQuery(url);
        const result = await service.createStartToken({
          ownerToken,
          request: await readJson(request, maximumJsonBytes),
        });
        logger({ kind: 'change_checkpoint_issued', evidence: result.evidence });
        json(response, 201, result);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/changes') {
        exactQuery(url, new Set(['pageToken', 'limit']));
        const result = await service.listChanges({
          ownerToken,
          pageToken: url.searchParams.get('pageToken'),
          limit: parsePageLimit(url.searchParams.get('limit')),
        });
        logger({
          kind: 'change_page_response',
          changes: result.changes.length,
          final: result.nextPageToken === null,
          evidence: result.evidence,
        });
        json(response, 200, result);
        return;
      }
      throw new NotFoundError();
    } catch (error) {
      const safe = error instanceof AppError ? error : new AppError('Internal error');
      logger({ kind: 'request_failed', code: safe.code, status: safe.status });
      const headers = safe instanceof RangeNotSatisfiableError
        ? { 'content-range': `bytes */${safe.totalBytes}` }
        : {};
      json(response, safe.status, { error: safe.code }, headers);
    }
  });
}
