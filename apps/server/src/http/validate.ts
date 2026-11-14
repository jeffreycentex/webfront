import type { Context } from 'hono';
import type { z } from 'zod';
import { badRequest } from './errors.js';

/**
 * Request parsing helpers. Validation failures throw and become 400 `validation_error`.
 *
 *   const body = await parseJson(c, loginRequestSchema);
 *   const query = parseQuery(c, pullQuerySchema);
 */

export async function parseJson<S extends z.ZodType>(c: Context, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw badRequest('Request body must be valid JSON');
  }
  return schema.parse(raw);
}

export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return schema.parse(c.req.query());
}

export function parseParams<S extends z.ZodType>(c: Context, schema: S): z.output<S> {
  return schema.parse(c.req.param());
}
