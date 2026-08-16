// OWNER: B1. Secret box, master secret file and password hashing.
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ENC_PREFIX,
  SecretBox,
  hashPassword,
  loadOrCreateMasterSecret,
  verifyPassword,
} from '../../src/config/crypto.js';

describe('SecretBox', () => {
  it('round-trips a value and produces the documented envelope', () => {
    const box = new SecretBox('master-secret-value');
    const blob = box.encrypt('ptr_super_secret_key');
    expect(blob.startsWith(ENC_PREFIX)).toBe(true);
    expect(blob.split(':')).toHaveLength(5);
    expect(blob).not.toContain('ptr_super_secret_key');
    expect(box.decrypt(blob)).toBe('ptr_super_secret_key');
    expect(box.isEncrypted(blob)).toBe(true);
    expect(box.isEncrypted('ptr_plain')).toBe(false);
  });

  it('produces a different ciphertext every time (random iv)', () => {
    const box = new SecretBox('master');
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('fails cleanly when the master secret changed', () => {
    const blob = new SecretBox('secret-a').encrypt('value');
    expect(() => new SecretBox('secret-b').decrypt(blob)).toThrowError(/cannot be decrypted/);
  });

  it('fails cleanly on a corrupt blob', () => {
    const box = new SecretBox('secret-a');
    expect(() => box.decrypt('enc:v1:zzz')).toThrowError(/malformed/);
    expect(() => box.decrypt('not-encrypted')).toThrowError(/enc:v1/);
  });

  it('derives a stable jwt secret that differs per master secret', () => {
    const a = new SecretBox('master-a');
    expect(a.jwtSecret()).toBe(a.jwtSecret());
    expect(a.jwtSecret()).not.toBe(new SecretBox('master-b').jwtSecret());
    expect(a.jwtSecret()).not.toContain('master-a');
  });
});

describe('loadOrCreateMasterSecret', () => {
  it('prefers APP_SECRET and does not write a file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pc-secret-'));
    try {
      const file = path.join(dir, 'secret.key');
      expect(await loadOrCreateMasterSecret(file, 'from-env-secret')).toBe('from-env-secret');
      await expect(stat(file)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('generates once, then reuses the file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'pc-secret-'));
    try {
      const file = path.join(dir, 'secret.key');
      const first = await loadOrCreateMasterSecret(file);
      expect(first).toHaveLength(44); // 32 random bytes, base64
      const second = await loadOrCreateMasterSecret(file);
      expect(second).toBe(first);
      expect((await readFile(file, 'utf8')).trim()).toBe(first);
      if (process.platform !== 'win32') {
        expect((await stat(file)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('password hashing', () => {
  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt:16384:8:1:')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('salts: the same password hashes differently every time', async () => {
    expect(await hashPassword('a-password')).not.toBe(await hashPassword('a-password'));
  });

  it('returns false (never throws) for malformed or missing hashes', async () => {
    for (const bad of [null, '', 'nonsense', 'scrypt:x:y:z:a:b', 'scrypt:16384:8:1:@@:@@', 'bcrypt:1:2:3:4:5']) {
      await expect(verifyPassword('any', bad as string | null)).resolves.toBe(false);
    }
  });
});
