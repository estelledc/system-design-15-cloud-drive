import { equalBytes, hmacSha256 } from './crypto.js';
import { exactObject, safeInteger } from './contracts.js';
import { ValidationError } from './errors.js';

const tokenPattern = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/;

export class CursorCodec {
  constructor(secret) {
    if (typeof secret !== 'string' || secret.length < 32 || secret.length > 256) {
      throw new ValidationError('cursor secret must contain 32-256 characters');
    }
    this.secret = secret;
  }

  #encode(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = hmacSha256(this.secret, encoded).toString('base64url');
    return `${encoded}.${signature}`;
  }

  checkpoint(ownerFingerprint, afterRevision) {
    safeInteger(afterRevision, 'after revision');
    return this.#encode({ v: 1, kind: 'checkpoint', owner: ownerFingerprint, after: afterRevision });
  }

  page(ownerFingerprint, afterRevision, upperRevision) {
    safeInteger(afterRevision, 'after revision');
    safeInteger(upperRevision, 'upper revision');
    if (afterRevision >= upperRevision) throw new ValidationError('page cursor bounds are invalid');
    return this.#encode({ v: 1, kind: 'page', owner: ownerFingerprint, after: afterRevision, upper: upperRevision });
  }

  decode(token, expectedOwner) {
    if (typeof token !== 'string' || token.length < 40 || token.length > 1_024) {
      throw new ValidationError('page token is invalid');
    }
    const match = tokenPattern.exec(token);
    if (!match) throw new ValidationError('page token is invalid');
    const expectedSignature = hmacSha256(this.secret, match[1]);
    let suppliedSignature;
    let payloadBytes;
    try {
      suppliedSignature = Buffer.from(match[2], 'base64url');
      payloadBytes = Buffer.from(match[1], 'base64url');
    } catch {
      throw new ValidationError('page token is invalid');
    }
    if (
      suppliedSignature.toString('base64url') !== match[2]
      || payloadBytes.toString('base64url') !== match[1]
      || !equalBytes(expectedSignature, suppliedSignature)
    ) throw new ValidationError('page token is invalid');

    let payload;
    try {
      payload = JSON.parse(payloadBytes.toString('utf8'));
    } catch {
      throw new ValidationError('page token is invalid');
    }
    if (payload?.kind === 'checkpoint') {
      exactObject(payload, new Set(['v', 'kind', 'owner', 'after']), 'checkpoint token');
      if (payload.v !== 1 || payload.owner !== expectedOwner) throw new ValidationError('page token is invalid');
      safeInteger(payload.after, 'after revision');
      return payload;
    }
    if (payload?.kind === 'page') {
      exactObject(payload, new Set(['v', 'kind', 'owner', 'after', 'upper']), 'page token');
      if (payload.v !== 1 || payload.owner !== expectedOwner) throw new ValidationError('page token is invalid');
      safeInteger(payload.after, 'after revision');
      safeInteger(payload.upper, 'upper revision');
      if (payload.after >= payload.upper) throw new ValidationError('page token bounds are invalid');
      return payload;
    }
    throw new ValidationError('page token is invalid');
  }
}
