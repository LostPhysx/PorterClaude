// OWNER: B1. Secret handling. APP_SECRET (env) or <DATA_DIR>/secret.key (auto-generated,
// mode 0600) is the master key. Values at rest look like:
//     enc:v1:<ivB64>:<tagB64>:<ciphertextB64>      (aes-256-gcm)
// Password hashes look like:
//     scrypt:<N>:<r>:<p>:<saltB64>:<hashB64>
// Nothing here may ever be logged.
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scrypt as scryptCb,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { AppError } from '../http/errors.js';

export const ENC_PREFIX = 'enc:v1:';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number },
) => Promise<Buffer>;

const CONFIG_KEY_INFO = 'porterclaude:config:v1';
const JWT_KEY_INFO = 'porterclaude:jwt:v1';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 4;

/** Load APP_SECRET, or read/create <secretFile>. Returns the raw secret string. */
export async function loadOrCreateMasterSecret(secretFile: string, envSecret?: string): Promise<string> {
  const fromEnv = envSecret?.trim();
  if (fromEnv) return fromEnv;

  try {
    const existing = (await fs.readFile(secretFile, 'utf8')).trim();
    if (existing) return existing;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  const generated = randomBytes(32).toString('base64');
  await fs.mkdir(path.dirname(secretFile), { recursive: true });
  try {
    await fs.writeFile(secretFile, `${generated}\n`, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // lost a race with another process: whoever wrote first wins
      const existing = (await fs.readFile(secretFile, 'utf8')).trim();
      if (existing) return existing;
    }
    throw err;
  }
  // best effort on platforms that ignore the mode on create (Windows)
  await fs.chmod(secretFile, 0o600).catch(() => undefined);
  return generated;
}

export class SecretBox {
  private cachedKey: Buffer | null = null;
  private cachedJwt: string | null = null;

  constructor(private readonly masterSecret: string) {}

  /** scrypt(masterSecret, "porterclaude:config:v1", 32) -> aes-256-gcm key (cached). */
  private key(): Buffer {
    if (!this.cachedKey) {
      this.cachedKey = scryptSync(this.masterSecret, CONFIG_KEY_INFO, 32, {
        N: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAXMEM,
      });
    }
    return this.cachedKey;
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
  }

  /** Throws AppError.internal when the blob is corrupt or the master secret changed. */
  decrypt(blob: string): string {
    if (!this.isEncrypted(blob)) throw AppError.internal('stored secret is not an enc:v1 blob');
    const parts = blob.slice(ENC_PREFIX.length).split(':');
    if (parts.length !== 3) throw AppError.internal('stored secret is malformed');
    try {
      const [ivB64, tagB64, ctB64] = parts as [string, string, string];
      const decipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(ivB64, 'base64'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw AppError.internal('stored secret cannot be decrypted (APP_SECRET changed?)');
    }
  }

  isEncrypted(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.startsWith(ENC_PREFIX);
  }

  /** Key for signing login cookies: hkdf(masterSecret, "porterclaude:jwt:v1"). */
  jwtSecret(): string {
    if (!this.cachedJwt) {
      const derived = hkdfSync('sha256', Buffer.from(this.masterSecret, 'utf8'), Buffer.alloc(0), JWT_KEY_INFO, 32);
      this.cachedJwt = Buffer.from(derived).toString('base64');
    }
    return this.cachedJwt;
  }
}

/** scrypt password hashing (no native deps). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}:${salt.toString('base64')}:${hash.toString('base64')}`;
}

/** Constant-time verification; returns false for malformed hashes instead of throwing. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) return false;
  if (N < 2 || r < 1 || p < 1 || N > 1 << 20 || r > 32 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] as string, 'base64');
    expected = Buffer.from(parts[5] as string, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  try {
    const actual = await scrypt(password, salt, expected.length, {
      N,
      r,
      p,
      maxmem: Math.max(SCRYPT_MAXMEM, 128 * N * r * 4),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
