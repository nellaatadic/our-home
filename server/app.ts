import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { HttpError } from './lib/http.js';
import { csrfMiddleware, sessionMiddleware } from './lib/auth.js';
import type { AppEnv } from './lib/access.js';
import { authRoutes, householdRoutes } from './routes/auth.js';
import { itemRoutes } from './routes/items.js';
import { shareRoutes } from './routes/share.js';
import { entityRoutes, threadRoutes } from './routes/threads.js';
import { attachmentRoutes } from './routes/attachments.js';
import { taskRoutes } from './routes/tasks.js';
import { eventRoutes } from './routes/events.js';
import { googleRoutes } from './routes/google.js';
import { receiptRoutes } from './routes/receipts.js';
import { householdModuleRoutes } from './routes/household.js';
import { aiConfigured } from './lib/ai.js';
import { googleConfig } from './lib/google.js';

export function createApp() {
  const app = new Hono<AppEnv>().basePath('/api');

  app.use('*', async (c, next) => {
    c.set('requestId', crypto.randomUUID());
    await next();
    c.header('cache-control', c.res.headers.get('cache-control') ?? 'no-store');
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'same-origin');
  });
  app.use('*', csrfMiddleware);
  app.use('*', sessionMiddleware);

  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/config', (c) => {
    const g = googleConfig();
    return c.json({ google_configured: g.configured, ai_configured: aiConfigured() });
  });

  app.route('/auth', authRoutes);
  app.route('/household', householdRoutes);
  for (const r of [itemRoutes, shareRoutes, threadRoutes, entityRoutes, attachmentRoutes, taskRoutes, eventRoutes, googleRoutes, receiptRoutes, householdModuleRoutes]) {
    app.route('/', r);
  }

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'Not found' } }, 404));
  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status as any);
    }
    if (err instanceof HTTPException) return c.json({ error: { code: 'http_error', message: err.message } }, err.status);
    if (err instanceof SyntaxError) return c.json({ error: { code: 'bad_json', message: 'Invalid request body' } }, 400);
    const pgCode = (err as any)?.code as string | undefined;
    if (pgCode === '23505') return c.json({ error: { code: 'conflict', message: 'That already exists' } }, 409);
    if (pgCode === '23514' || pgCode === '22P02' || pgCode === '22007' || pgCode === '22008') {
      return c.json({ error: { code: 'bad_request', message: 'Some values are not valid' } }, 400);
    }
    // Log without request bodies or secrets.
    console.error(JSON.stringify({ level: 'error', requestId: c.get('requestId'), path: new URL(c.req.url).pathname, message: (err as Error).message, stack: (err as Error).stack?.split('\n').slice(0, 5).join(' | ') }));
    return c.json({ error: { code: 'internal', message: 'Something went wrong. Please try again.', request_id: c.get('requestId') } }, 500);
  });
  return app;
}

export const app = createApp();
