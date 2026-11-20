# OUR HOME

A private household app for two people: three built-in lists (Groceries, Home & Gadgets, Shopping & Other) plus any lists you make, a Board for sticky notes and photos, plans for events, a chat about every card, a calendar with both schedules, and a data page. Everything is shared between the two of you unless you lock it.

Features: NEED / STOCK lists with sections, search and filters; Reminders-style item details (date, time, urgent, repeat, early reminder, subtasks, flag, priority, photos); a comment button on every item; a Chat page with conversation cards and one ongoing chat where you can @-link any card; replies to a tagged message in the main chat are copied into the card it is about; a Board (sticky notes, words, photos, links you drag and resize); plans (events with a checklist, their own lists, linked cards, tags and an archive prompt once they are over); lists of your own; “Share to OUR HOME” from other apps; a dashboard with list widgets, plans, important dates, to-dos and today's schedule; day / week / month calendar with Google import and export and events from pasted text; receipt review; spending, grocery-habit and calendar-load charts; notifications, search and an archive. Defaults: Toronto time, Canadian dollars. Look: the warm “Paper” theme (Fraunces and Inter Tight, self-hosted).

- **Frontend:** React 19 + Vite (single-page app), responsive with a mobile tab bar
- **API:** Hono running in one Netlify Function (`/api/*`), with a plain Node server for local development
- **Database:** Postgres through [Netlify Database](https://docs.netlify.com/build/data-and-storage/netlify-database/). SQL migrations live in `netlify/database/migrations/`.
- **Files:** Netlify Blobs (private; files are served only through an authorized API route)
- **Optional integrations:** Google Calendar (OAuth 2.0, Calendar API v3) and the Claude API (reading receipts, turning text into events)

See [docs/FEATURES.md](docs/FEATURES.md) for which features work out of the box and which need configuration, and [docs/TEST_REPORT.md](docs/TEST_REPORT.md) for test results.

---

## How privacy works

Every record (item, task, event, inventory entry, expense, receipt, thread, attachment) belongs to exactly one **workspace**:

| Workspace | Who can read and write it |
|---|---|
| `personal` (ME) | Only its owner |
| `shared` (US) | Both members of the household |

The server works out the current user's two allowed workspace ids from their session. Every query filters on them in SQL (`WHERE workspace_id = ANY($allowed)`), so an id outside those workspaces looks the same as a missing one (HTTP 404). Notifications and @mentions only go to people who can already see the workspace, and search only looks inside the two allowed workspaces. The YOU page is built only from US data and never queries the partner's private space.

**Shared unless locked.** New items, to-dos, events and topics go to US unless you tick the lock. Locking an item (only the person who added it can) moves it, with its chat, photos, subtasks, reactions and history, into that person's private workspace, and removes the partner's notifications and favourites for it. Unlocking moves it back. In a shared chat, the @ card picker only offers shared records. The partner's private calendar is never shown, except as anonymous "Busy" blocks if they turn that on in Settings (off by default).

**Google events are copies too.** Imported events become OUR HOME events. Editing or deleting them never calls a Google write API: import uses read-only scopes and requests are re-read on the server. Export is a one-way `events.insert` into a calendar *you* choose. It needs explicit confirmation and is recorded in `event_exports`, which is what prevents duplicates.

---

## Run it locally

Requirements: Node ≥ 20.12, and Postgres 15+ (Postgres.app, Homebrew or Docker all work).

```bash
npm install
cp .env.example .env          # then fill in the values below
```

Minimum `.env` for local development:

```
DATABASE_URL=postgres://USER@localhost:5432/ourhome
TOKEN_ENCRYPTION_KEY=<output of the command below>
APP_URL=http://localhost:5173
```

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```bash
createdb ourhome              # or create it any other way
npm run dev                   # applies migrations, starts API on :8787 and web on :5173
```

Open http://localhost:5173 and create your household. You can also run `npm run seed:dev` to create two local test accounts (it refuses to run against a non-local database; the credentials are in `scripts/seed-dev.ts`). Use two browsers, or a private window, to see both points of view.

### Tests

```bash
createdb ourhome_test
TEST_DATABASE_URL=postgres://USER@localhost:5432/ourhome_test npm test
```

The test suite **drops and recreates the `public` schema** of the test database, so never point it at real data. By default it uses `postgres://ourhome@localhost:5433/ourhome_test`.

---

## Deploy to Netlify

1. Push this repository to the private GitHub repo `our-home`.
2. In Netlify, choose **Add new project → Import an existing project → GitHub**. When GitHub asks which repositories to grant, pick **Only select repositories → `our-home`**, not all repositories.
3. Build settings are read from `netlify.toml` (build: `npm run build`, publish: `dist`, functions in `netlify/functions`).
4. **Database:** this project depends on `@netlify/database`, so Netlify Database is provisioned automatically on the first deploy. Migrations in `netlify/database/migrations/` are applied before each deploy is published, and a failed migration blocks the publish. Netlify sets `NETLIFY_DB_URL`; do **not** set `DATABASE_URL` on Netlify. (Netlify Database needs a credit-based Netlify plan.)
5. **Environment variables** (Site configuration → Environment variables). Mark the secret ones as secret:
   - `TOKEN_ENCRYPTION_KEY` (required): 32 random bytes, base64. Keep it stable: changing it makes stored Google tokens unreadable, and everyone would have to reconnect.
   - `APP_URL` (required): e.g. `https://our-home.netlify.app`
   - `SIGNUP_MODE` (optional): leave unset (`first-user-only`). The first person to register creates the household, after which joining is by invite only.
   - Google and AI variables (optional, see below)
6. Deploy, then open the site. **Register straight away.** Until the first account exists, anyone with the URL could sign up as the primary user.
7. Go to Settings → **Create invite link** and send the link to your partner.

The scheduled function `netlify/functions/reminders.ts` runs every 15 minutes and turns due task reminders into notifications. Opening the app also checks for due reminders.

### Backups and recovery

- **Netlify Database:** use its built-in backups / point-in-time recovery (Netlify UI → Database). For your own copy: `pg_dump "$(netlify database connect --json | jq -r .connection_string)" > ourhome.sql`. Restore with `psql`.
- **Files** live in the `attachments` Blobs store. Netlify CLI: `netlify blobs:list attachments`, `netlify blobs:get attachments <key>`.
- **Safe defaults:** deleting archives first, permanent deletion requires a confirmation, and migrations are append-only (an edited migration is rejected).

---

## Optional integrations

### Google Calendar

Follow [docs/GOOGLE_OAUTH.md](docs/GOOGLE_OAUTH.md). Until `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL` and `TOKEN_ENCRYPTION_KEY` are all set, the app shows Google Calendar as **not configured** and lists the missing variables. It never pretends to be connected.

### Receipt reading and text-to-event AI

Set `ANTHROPIC_API_KEY` (from https://console.anthropic.com). The model defaults to `claude-opus-5-5`; override it with `ANTHROPIC_MODEL`, or set `AI_FEATURES=off` to disable AI.

- **Without a key:** events are found by the built-in parser (chrono-node plus rules), and receipts are read from pasted text or entered by hand. A receipt photo is stored and you review it manually.
- **With a key:** photos and PDFs are read by Claude, and pasted text is turned into events by Claude. The server-side refusal fallback (`fallbacks: "default"`) is enabled. If the call fails, the app falls back to the built-in parser.
- **Either way,** nothing is saved without your review. Ambiguous dates must be picked, missing times stay "not set", and receipt lines the app is unsure about are flagged.

Images and PDFs are sent to Anthropic only when a key is configured.

---

## Project layout

```
netlify/
  database/migrations/   SQL migrations (applied by Netlify on deploy, by server/migrate.ts locally)
  functions/api.ts       all /api/* routes (Hono app)
  functions/reminders.ts scheduled reminder dispatch
server/
  app.ts                 route wiring, error handling, security headers
  db.ts                  pg pool (local) / Netlify Database pool (production)
  lib/access.ts          workspace authorization helpers
  lib/auth.ts            sessions, CSRF, rate limiting
  lib/google.ts          OAuth + Calendar API client (PKCE, encrypted tokens)
  lib/nlp.ts             text → event drafts
  lib/receipts.ts        receipt text parsing + product matching
  lib/ai.ts              optional Claude integration
  lib/linkpreview.ts     SSRF-safe product link previews
  routes/*.ts            auth, items, share, threads, tasks, events, google, receipts, household modules
src/                     React app (pages/, components/, lib/)
tests/                   Vitest: API scenario tests (two real accounts), unit tests, UI tests
```

### Adding a module

Create a table in a new migration with a `workspace_id` column, load rows with `loadEntity()` / `accessibleWorkspaceIds()`, and register the type in `ENTITY_TABLES` in `server/lib/access.ts`. The new records then get threads, reactions, favourites, archiving and activity history automatically.

## Security notes

- Passwords are hashed with scrypt. Sessions are random 256-bit tokens, stored only as SHA-256 hashes, in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS). Changing your password signs out your other sessions.
- **CSRF:** every mutation must send the `X-OurHome` header, and its `Origin` must match the host.
- **Rate limits:** login (per IP and per email), registration, invites and AI calls.
- **Validation:** every request body is checked with zod. The database adds CHECK constraints, foreign keys and unique indexes.
- **Uploads:** file types are detected from their content (JPEG, PNG, WebP, GIF, HEIC, PDF), with a 4 MB cap; photos are shrunk in the browser first. Files are served with `nosniff`, a sandboxing CSP, and only after an access check.
- **Link previews:** fetch only public http(s) addresses (private, loopback and metadata IPs are blocked, including after redirects) and read at most about 600 KB. (DNS rebinding between the lookup and the fetch is not fully prevented.)
- **Google tokens:** encrypted with AES-256-GCM, never sent to the browser, revoked on disconnect.
- **Error logs:** contain the request id, path and message only, never bodies or secrets.
