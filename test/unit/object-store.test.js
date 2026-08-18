import assert from 'node:assert/strict';
import { mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { IntegrityError, ValidationError } from '../../src/errors.js';
import { LocalImmutableObjectStore } from '../../src/object-store.js';

test('concurrent immutable installs converge on one verified object', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drive-object-concurrency-'));
  const store = new LocalImmutableObjectStore(root);
  const bytes = Buffer.alloc(32_768, 15);
  const writes = await Promise.all(Array.from({ length: 32 }, () => store.put(Buffer.from(bytes))));
  assert.equal(new Set(writes.map((write) => write.digest)).size, 1);
  assert.equal(writes.filter((write) => write.created).length, 1);
  assert.ok((await store.read(writes[0].digest, bytes.length)).equals(bytes));
  const directory = join(root, 'objects', writes[0].digest.slice(0, 2));
  assert.deepEqual(await readdir(directory), [writes[0].digest]);
});

test('readback detects external corruption and missing objects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drive-object-corruption-'));
  const store = new LocalImmutableObjectStore(root);
  const stored = await store.put(Buffer.from('synthetic file bytes'));
  const path = join(root, 'objects', stored.digest.slice(0, 2), stored.digest);
  await writeFile(path, 'changed');
  await assert.rejects(store.read(stored.digest), IntegrityError);
  await assert.rejects(store.read('f'.repeat(64)), IntegrityError);
});

test('object adapter rejects empty, oversized, and invalid digest inputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'drive-object-bounds-'));
  const store = new LocalImmutableObjectStore(root, { maximumObjectBytes: 8 });
  await assert.rejects(store.put(Buffer.alloc(0)), ValidationError);
  await assert.rejects(store.put(Buffer.alloc(9)), ValidationError);
  await assert.rejects(store.read('../escape'), ValidationError);
});
