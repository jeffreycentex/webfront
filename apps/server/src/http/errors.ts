import { ERROR_CODES, type ApiError } from '@webfront/shared';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { ZodError } from 'zod';
import type { Logger } from '../logger.js';
import type { AppEnv } from '../context.js';

/**
 * Structured errors. Throw `AppError` (or use the helpers) anywhere in a handler; the app's
 * error handler turns it into `{ error: { code, message, details?, requestId } }` (ApiError).
 * A thrown ZodError becomes a 400 `validation_error`. Anything else is a logged 500 with no
 * internal detail leaked.
 */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, ERROR_CODES.validation, message, details);
export const unauthorized = (message = 'Not signed in') =>
  new AppError(401, ERROR_CODES.unauthorized, message);
export const forbidden = (message = 'Forbidden') =>
  new AppError(403, ERROR_CODES.forbidden, message);
export const notFound = (message = 'Not found') => new AppError(404, ERROR_CODES.notFound, message);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, ERROR_CODES.conflict, message, details);
export const notImplemented = (message = 'Not implemented') =>
  new AppError(501, ERROR_CODES.notImplemented, message);

function body(c: Context<AppEnv>, code: string, message: string, details?: unknown): ApiError {
  const err: ApiError['error'] = { code, message, requestId: c.get('requestId') };
  if (details !== undefined) err.details = details;
  return { error: err };
}

export function createErrorHandler(logger: Logger): ErrorHandler<AppEnv> {
  return (err, c) => {
    if (err instanceof AppError) {
      if (err.status >= 500) logger.error('request failed', { err, requestId: c.get('requestId') });
      return c.json(body(c, err.code, err.message, err.details), err.status);
    }
    if (err instanceof ZodError) {
      const issues = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return c.json(body(c, ERROR_CODES.validation, 'Invalid request', issues), 400);
    }
    if (err instanceof HTTPException) {
      if (err.res) return err.res;
      const code =
        err.status === 401
          ? ERROR_CODES.unauthorized
          : err.status === 404
            ? ERROR_CODES.notFound
            : 'http_error';
      return c.json(
        body(c, code, err.message || 'Request failed'),
        err.status as ContentfulStatusCode,
      );
    }
    logger.error('unhandled error', { err, requestId: c.get('requestId'), path: c.req.path });
    return c.json(body(c, ERROR_CODES.internal, 'Internal server error'), 500);
  };
}

export const apiNotFound: NotFoundHandler<AppEnv> = (c) =>
  c.json(body(c, ERROR_CODES.notFound, `No route for ${c.req.method} ${c.req.path}`), 404);
