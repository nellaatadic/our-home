import { z } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what = 'Not found') => new HttpError(404, 'not_found', what);
export const forbidden = (what = 'You do not have access to this') => new HttpError(403, 'forbidden', what);
export const badRequest = (what: string, details?: unknown) => new HttpError(400, 'bad_request', what, details);
export const conflict = (what: string, details?: unknown) => new HttpError(409, 'conflict', what, details);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new HttpError(400, 'validation_error', issues[0] ? `${issues[0].path || 'input'}: ${issues[0].message}` : 'Invalid input', issues);
  }
  return r.data;
}

// ---- shared field schemas
export const uuid = z.string().uuid();
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM');
export const priority = z.enum(['urgent', 'high', 'normal', 'low']);
export const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => (v ? v : null));
export const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  }, 'Must be an http(s) link');
export const optUrl = z.union([httpUrl, z.literal(''), z.null()]).optional().transform((v) => (v ? v : null));
export const space = z.enum(['me', 'us']);
