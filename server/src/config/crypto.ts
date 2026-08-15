// OWNER: B1. Secret handling. APP_SECRET (env) or <DATA_DIR>/secret.key (auto-generated,
// mode 0600) is the master key. Values at rest look like:
//     enc:v1:<ivB64>:<tagB64>:<ciphertextB64>      (aes-256-gcm)
// Password hashes look like:
//     scrypt:<N>:<r>:<p>:<saltB64>:<hashB64>
// Nothing here may ever be logged.

export const ENC_PREFIX = 'enc:v1:';

/** Load APP_SECRET, or read/create <secretFile>. Returns the raw secret string. */
export async function loadOrCreateMasterSecret(secretFile: string, envSecret?: string): Promise<string> {
  throw new Error('TODO(B1): implement loadOrCreateMasterSecret');
}

export class SecretBox {
  constructor(private readonly masterSecret: string) {}

  /** scrypt(masterSecret, "porterclaude:config:v1", 32) -> aes-256-gcm key (cached). */
  private key(): Buffer {
    throw new Error('TODO(B1)');
  }

  encrypt(plain: string): string {
    throw new Error('TODO(B1)');
  }

  /** Throws AppError.internal when the blob is corrupt or the master secret changed. */
  decrypt(blob: string): string {
    throw new Error('TODO(B1)');
  }

  isEncrypted(value: string | null | undefined): boolean {
    return typeof value === 'string' && value.startsWith(ENC_PREFIX);
  }

  /** Key for signing session cookies: hkdf(masterSecret, "porterclaude:jwt:v1"). */
  jwtSecret(): string {
    throw new Error('TODO(B1)');
  }
}

/** scrypt password hashing (no native deps). */
export async function hashPassword(password: string): Promise<string> {
  throw new Error('TODO(B1)');
}

/** Constant-time verification; returns false for malformed hashes instead of throwing. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  throw new Error('TODO(B1)');
}
