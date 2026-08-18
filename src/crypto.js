import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function digestJson(value) {
  return sha256(JSON.stringify(value));
}

export function ownerFingerprint(token) {
  return sha256(`cloud-drive-owner-v1\0${token}`);
}

export function hmacSha256(secret, value) {
  return createHmac('sha256', secret).update(value).digest();
}

export function equalBytes(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}
