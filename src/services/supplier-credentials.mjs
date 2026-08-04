import {
  createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual,
} from 'node:crypto';

function encryptionKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const candidate = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (candidate.length !== 32) throw new Error('SUPPLIER_CREDENTIALS_KEY must encode exactly 32 bytes');
  return candidate;
}

export class SupplierCredentialVault {
  constructor(secret) {
    this.key = encryptionKey(secret);
  }

  get available() {
    return Boolean(this.key);
  }

  encrypt(value) {
    if (!this.key) throw Object.assign(new Error('supplier credential encryption is not configured'), { statusCode: 503 });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value || {}), 'utf8');
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  decrypt(value) {
    if (!this.key) throw Object.assign(new Error('supplier credential encryption is not configured'), { statusCode: 503 });
    const [version, ivValue, tagValue, ciphertextValue, extra] = String(value || '').split('.');
    if (version !== 'v1' || !ivValue || !tagValue || !ciphertextValue || extra) throw new Error('invalid encrypted supplier credential');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivValue, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, 'base64url')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  }

  fingerprint(value) {
    if (!this.key || !value) return '';
    return createHmac('sha256', this.key).update(String(value)).digest('hex');
  }
}

export function maskSecret(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}****${text.slice(-2)}`;
  return `${text.slice(0, 5)}...${text.slice(-4)}`;
}

function decodeBase32(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const normalized = String(value || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const character of normalized) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('invalid TOTP secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
}

export function totpCode(secret, now = Date.now()) {
  const key = decodeBase32(secret);
  if (!key.length) throw new Error('invalid TOTP secret');
  const counter = Math.floor(now / 30_000);
  const payload = Buffer.alloc(8);
  payload.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', key).update(payload).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, '0');
}

export function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}
