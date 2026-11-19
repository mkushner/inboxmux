import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export class Keyring {
  readonly currentId: string;
  private readonly keys = new Map<string, Buffer>();

  // Spec: "id:base64key[,id:base64key...]"; the first key encrypts, all keys decrypt.
  constructor(spec: string) {
    const entries = spec
      .split(',')
      .map((e) => e.trim())
      .filter(Boolean);
    for (const entry of entries) {
      const [id, b64] = entry.includes(':') ? entry.split(':', 2) : ['default', entry];
      const key = Buffer.from(b64 ?? '', 'base64');
      if (!id || key.length !== 32) throw new Error(`Encryption key "${id}" must be 32 bytes of base64`);
      this.keys.set(id, key);
    }
    const first = entries[0];
    if (!first) throw new Error('INBOXMUX_ENCRYPTION_KEY is empty');
    this.currentId = first.includes(':') ? (first.split(':', 1)[0] as string) : 'default';
  }

  encrypt(plaintext: string): string {
    const key = this.keys.get(this.currentId) as Buffer;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(`${VERSION}.${this.currentId}`));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, this.currentId, iv, cipher.getAuthTag(), ct]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.');
  }

  decrypt(blob: string): string {
    const [version, id, iv, tag, ct] = blob.split('.');
    if (version !== VERSION || !id || !iv || !tag || ct === undefined)
      throw new Error('Malformed ciphertext');
    const key = this.keys.get(id);
    if (!key) throw new Error(`Unknown encryption key id "${id}"`);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(`${version}.${id}`));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  }

  isCurrent(blob: string): boolean {
    return blob.split('.')[1] === this.currentId;
  }
}

export const generateKey = () => randomBytes(32).toString('base64');

export const randomToken = (prefix = '') => prefix + randomBytes(32).toString('base64url');

export const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');
