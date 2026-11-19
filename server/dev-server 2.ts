import { serve } from '@hono/node-server';
import { app } from './app.js';
import { migrate } from './migrate.js';

const port = Number(process.env.API_PORT ?? 8787);
await migrate(undefined, (m) => console.log(`[db] ${m}`));
serve({ fetch: app.fetch, port }, () => console.log(`OUR HOME API listening on http://localhost:${port}`));
