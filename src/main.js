import { Pool } from 'pg';
import { CloudDriveService } from './cloud-drive-service.js';
import { CursorCodec } from './cursor-codec.js';
import { createHttpServer } from './http-server.js';
import { LocalImmutableObjectStore } from './object-store.js';
import { PostgresCloudDriveRepository } from './postgres-repository.js';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integerEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
  return Number(raw);
}

function authTokens() {
  let parsed;
  try {
    parsed = JSON.parse(required('AUTH_TOKENS_JSON'));
  } catch {
    throw new Error('AUTH_TOKENS_JSON must be a JSON array');
  }
  if (
    !Array.isArray(parsed)
    || parsed.length === 0
    || parsed.length > 100
    || parsed.some((token) => typeof token !== 'string' || token.length < 16 || token.length > 256)
  ) throw new Error('AUTH_TOKENS_JSON must contain 1-100 tokens of 16-256 characters');
  return new Set(parsed);
}

function record(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (process.argv[2] !== 'serve') throw new Error('command must be serve');

const pool = new Pool({ connectionString: required('DATABASE_URL') });
const objects = new LocalImmutableObjectStore(required('OBJECT_ROOT'));
const repository = new PostgresCloudDriveRepository(pool, objects);
const fixedNow = process.env.CLOCK_MS === undefined ? undefined : integerEnvironment('CLOCK_MS', 0);
const service = new CloudDriveService(repository, new CursorCodec(required('CURSOR_SECRET')), {
  now: fixedNow === undefined ? undefined : () => fixedNow,
});
await repository.migrate();

const server = createHttpServer({
  service,
  authTokens: authTokens(),
  health: () => repository.health(),
  logger: record,
  afterChunkCommitted: process.env.CRASH_AFTER_CHUNK_COMMIT === '1'
    ? async (result) => {
        if (!result.created) return;
        const line = `${JSON.stringify({ kind: 'chunk_committed_before_response', bytes: result.bytes })}\n`;
        await new Promise((resolve) => process.stdout.write(line, resolve));
        process.kill(process.pid, 'SIGKILL');
      }
    : undefined,
  afterMutationCommitted: process.env.CRASH_AFTER_MUTATION_COMMIT === '1'
    ? async (result) => {
        const line = `${JSON.stringify({ kind: 'mutation_committed_before_response', operation: result.kind })}\n`;
        await new Promise((resolve) => process.stdout.write(line, resolve));
        process.kill(process.pid, 'SIGKILL');
      }
    : undefined,
});

const host = process.env.HOST ?? '127.0.0.1';
const port = integerEnvironment('PORT', 3000);
server.listen(port, host, () => {
  const address = server.address();
  record({ kind: 'api_listening', port: typeof address === 'object' ? address.port : port });
});

const shutdown = () => {
  server.close(async () => {
    await pool.end();
    process.exitCode = 0;
  });
};
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
