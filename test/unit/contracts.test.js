import assert from 'node:assert/strict';
import test from 'node:test';
import {
  formatVersionEtag,
  parseIfMatch,
  parseOffsetHeader,
  parsePageLimit,
  parseSingleByteRange,
  validateCreateIntent,
  validateUploadIntent,
} from '../../src/contracts.js';
import { RangeNotSatisfiableError, ValidationError } from '../../src/errors.js';

const digest = 'a'.repeat(64);
const uploadId = '00000000-0000-4000-8000-000000000001';

test('upload and flat-name intents are exact, bounded, and case-normalized', () => {
  assert.deepEqual(validateUploadIntent({ expectedBytes: 10, expectedSha256: digest }), {
    expectedBytes: 10,
    expectedSha256: digest,
  });
  assert.deepEqual(validateCreateIntent({ name: 'Report 01.txt', uploadId }), {
    name: 'Report 01.txt',
    normalizedName: 'report 01.txt',
    uploadId,
  });
  for (const name of ['', ' report', 'report ', '.hidden', 'a/b', 'a\\b', 'é.txt', 'a'.repeat(129)]) {
    assert.throws(() => validateCreateIntent({ name, uploadId }), ValidationError);
  }
  assert.throws(() => validateUploadIntent({ expectedBytes: 10, expectedSha256: digest, mime: 'text/plain' }), ValidationError);
});

test('If-Match accepts exactly one strong UUID version validator', () => {
  assert.equal(parseIfMatch(`"${uploadId}"`), uploadId);
  assert.equal(formatVersionEtag(uploadId), `"${uploadId}"`);
  for (const value of [undefined, '*', `W/"${uploadId}"`, `"${uploadId}", "${uploadId}"`, uploadId]) {
    assert.throws(() => parseIfMatch(value), ValidationError);
  }
});

test('offset, page, and single-range bounds reject ambiguous inputs', () => {
  assert.equal(parseOffsetHeader('0'), 0);
  assert.equal(parsePageLimit(null), 25);
  assert.equal(parsePageLimit('100'), 100);
  assert.deepEqual(parseSingleByteRange('bytes=2-4', 6), { status: 206, start: 2, end: 4, length: 3 });
  assert.deepEqual(parseSingleByteRange('bytes=-2', 6), { status: 206, start: 4, end: 5, length: 2 });
  assert.deepEqual(parseSingleByteRange(undefined, 6), { status: 200, start: 0, end: 5, length: 6 });
  for (const value of ['01', '-1', '1.0']) assert.throws(() => parseOffsetHeader(value), ValidationError);
  for (const value of ['0', '101', '1.0']) assert.throws(() => parsePageLimit(value), ValidationError);
  assert.throws(() => parseSingleByteRange('bytes=0-1,3-4', 6), ValidationError);
  assert.throws(() => parseSingleByteRange('bytes=6-', 6), RangeNotSatisfiableError);
});
