// FROZEN (planner-authored, fully implemented). Shared by B1 and B2. Do not change signatures.
// Canonical error envelope for every /api response:  { "error": { code, message, details? } }

export type ErrorCode =
  | 'bad_request'
  | 'validation_error'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'backend_not_configured'
  | 'backend_error'
  | 'rate_limited'
  | 'not_implemented'
  | 'internal';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_error: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  backend_not_configured: 409,
  backend_error: 502,
  rate_limited: 429,
  not_implemented: 501,
  internal: 500,
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly expose = true;

  constructor(code: ErrorCode, message: string, details?: unknown, status?: number) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status ?? STATUS_BY_CODE[code];
    this.details = details;
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details === undefined ? {} : { details: this.details }) } };
  }

  static badRequest(m: string, d?: unknown) { return new AppError('bad_request', m, d); }
  static validation(m: string, d?: unknown) { return new AppError('validation_error', m, d); }
  static unauthorized(m = 'authentication required') { return new AppError('unauthorized', m); }
  static forbidden(m = 'forbidden') { return new AppError('forbidden', m); }
  static notFound(m: string, d?: unknown) { return new AppError('not_found', m, d); }
  static conflict(m: string, d?: unknown) { return new AppError('conflict', m, d); }
  static backendNotConfigured(m = 'no docker backend configured') { return new AppError('backend_not_configured', m); }
  static notImplemented(m = 'not implemented') { return new AppError('not_implemented', m); }
  static internal(m = 'internal error', d?: unknown) { return new AppError('internal', m, d); }
}

/** Raised by DockerBackend implementations when the Docker/Portainer API says no. */
export class DockerApiError extends AppError {
  readonly dockerStatus: number | undefined;
  constructor(message: string, dockerStatus?: number, details?: unknown) {
    super('backend_error', message, details, dockerStatus === 404 ? 404 : 502);
    this.name = 'DockerApiError';
    this.dockerStatus = dockerStatus;
  }
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) return new AppError('internal', err.message);
  return new AppError('internal', String(err));
}
