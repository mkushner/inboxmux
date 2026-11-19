import { describe, expect, it } from 'vitest';
import { generateKey, Keyring } from '../src/crypto.js';

describe('Keyring', () => {
  const k1 = generateKey();
  const k2 = generateKey();

  it('round-trips and authenticates ciphertext', () => {
    const ring = new Keyring(`k1:${k1}`);
    const blob = ring.encrypt('app-password');
    expect(blob).not.toContain('app-password');
    expect(ring.decrypt(blob)).toBe('app-password');
    const [v, id, iv, tag, ct] = blob.split('.');
    const flipped = Buffer.from(ct as string, 'base64url');
    flipped[0] = (flipped[0] as number) ^ 1;
    expect(() => ring.decrypt([v, id, iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
  });

  it('decrypts with old keys after rotation and encrypts with the first key', () => {
    const old = new Keyring(`k1:${k1}`).encrypt('secret');
    const rotated = new Keyring(`k2:${k2},k1:${k1}`);
    expect(rotated.decrypt(old)).toBe('secret');
    expect(rotated.isCurrent(old)).toBe(false);
    expect(rotated.isCurrent(rotated.encrypt('secret'))).toBe(true);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new Keyring('k1:c2hvcnQ=')).toThrow(/32 bytes/);
  });
});
