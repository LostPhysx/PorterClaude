// OWNER: B1. Core tests: config store round-trip, crypto, auth cookie flow, health route,
// vendor route resolution, backend mapping helpers (dockerMap.*) with a stubbed transport.
import { describe, it, expect } from 'vitest';

describe('porterclaude core', () => {
  it('placeholder until B1 implements the core package', () => {
    expect(true).toBe(true);
  });
});

// TODO(B1):
//  - SecretBox encrypt/decrypt round-trip; decrypt with a different master secret fails
//  - hashPassword/verifyPassword (wrong password -> false, malformed hash -> false)
//  - ConfigStore.init on an empty DATA_DIR creates config.json with defaults + seeds
//    APP_PASSWORD; second init keeps the hash
//  - ConfigStore.update is atomic (no partial file) and emits 'change'
//  - GET /api/health is reachable without a cookie; GET /api/settings without a cookie -> 401
//  - POST /api/auth/login with the right password sets an httpOnly cookie; wrong -> 401
//  - password change bumps tokenVersion and invalidates the old cookie
//  - sanitized settings never contain the api key
