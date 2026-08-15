// FROZEN (planner-authored, fully implemented).
import { randomUUID, randomBytes } from 'node:crypto';

export function uuid(): string {
  return randomUUID();
}

export function shortId(bytes = 6): string {
  return randomBytes(bytes).toString('hex');
}
