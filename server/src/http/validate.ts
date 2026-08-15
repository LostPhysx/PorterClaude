// FROZEN (planner-authored). zod v3 parsing helpers that produce the canonical error envelope.
import type { Request } from 'express';
import type { ZodTypeAny, z } from 'zod';
import { AppError } from './errors.js';

function fail(where: string, err: unknown): never {
  const issues = (err as { issues?: unknown }).issues ?? [];
  throw AppError.validation(`invalid ${where}`, issues);
}

export function parseBody<S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  const r = schema.safeParse(req.body);
  if (!r.success) fail('request body', r.error);
  return r.data;
}

export function parseQuery<S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  const r = schema.safeParse(req.query);
  if (!r.success) fail('query string', r.error);
  return r.data;
}

export function parseParams<S extends ZodTypeAny>(schema: S, req: Request): z.infer<S> {
  const r = schema.safeParse(req.params);
  if (!r.success) fail('path parameters', r.error);
  return r.data;
}
