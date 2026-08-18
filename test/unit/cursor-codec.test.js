import assert from 'node:assert/strict';
import test from 'node:test';
import { CursorCodec } from '../../src/cursor-codec.js';
import { ValidationError } from '../../src/errors.js';

const owner = 'a'.repeat(64);
const otherOwner = 'b'.repeat(64);
const codec = new CursorCodec('cursor-test-secret-that-is-long-enough-0001');

function generator(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
}

test('checkpoint and page tokens round-trip exact owner and bounds', () => {
  assert.deepEqual(codec.decode(codec.checkpoint(owner, 7), owner), {
    v: 1,
    kind: 'checkpoint',
    owner,
    after: 7,
  });
  assert.deepEqual(codec.decode(codec.page(owner, 7, 12), owner), {
    v: 1,
    kind: 'page',
    owner,
    after: 7,
    upper: 12,
  });
  assert.throws(() => codec.decode(codec.checkpoint(owner, 7), otherOwner), ValidationError);
  assert.throws(() => codec.page(owner, 7, 7), ValidationError);
});

test('token byte changes, non-canonical encodings, and unsupported shapes fail closed', () => {
  const token = codec.page(owner, 2, 9);
  const changed = `${token.slice(0, -1)}${token.at(-1) === 'A' ? 'B' : 'A'}`;
  assert.throws(() => codec.decode(changed, owner), ValidationError);
  assert.throws(() => codec.decode(`${token}=`, owner), ValidationError);
  assert.throws(() => codec.decode('not-a-token', owner), ValidationError);
  assert.throws(() => new CursorCodec('short'), ValidationError);
});

test('generated cursor corpus preserves signed snapshot bounds', () => {
  const next = generator(15_2026);
  for (let trial = 0; trial < 200; trial += 1) {
    const after = next() % 100_000;
    const upper = after + 1 + (next() % 1_000);
    const token = codec.page(owner, after, upper);
    const decoded = codec.decode(token, owner);
    assert.equal(decoded.after, after);
    assert.equal(decoded.upper, upper);
  }
});
