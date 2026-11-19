import { createHash } from 'node:crypto';
import { q, q1 } from '../db.js';
import { decryptSecret, encryptSecret, randomToken } from './crypto.js';
import { HttpError } from './http.js';
import { addDays, utcToZoned } from './time.js';

/**
 * Google Calendar integration (OAuth 2.0 + Calendar API v3 over REST).
 * Import uses read-only scopes. Write access (calendar.events) is requested
 * separately, only when a user chooses to export events, and is only used to
 * INSERT new events in a calendar the user picks — never to modify or delete.
 */
export const SCOPES = {
  base: ['openid', 'email', 'profile'],
  import: ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly'],
  export: ['https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events'],
};
export const WRITE_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/** Indirection so tests can stub Google without network access. */
export const googleHttp = { fetch: (input: string, init?: RequestInit) => fetch(input, init) };

export function googleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const appUrl = process.env.APP_URL;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? (appUrl ? `${appUrl.replace(/\/$/, '')}/api/google/callback` : null);
  const missing = [
    !clientId && 'GOOGLE_CLIENT_ID', !clientSecret && 'GOOGLE_CLIENT_SECRET', !redirectUri && 'APP_URL (or GOOGLE_REDIRECT_URI)',
    !process.env.TOKEN_ENCRYPTION_KEY && 'TOKEN_ENCRYPTION_KEY',
  ].filter(Boolean) as string[];
  return { clientId, clientSecret, redirectUri, configured: missing.length === 0, missing };
}

export function requireGoogle() {
  const cfg = googleConfig();
  if (!cfg.configured) throw new HttpError(503, 'google_not_configured', `Google Calendar is not configured on this server. Missing: ${cfg.missing.join(', ')}`);
  return cfg as { clientId: string; clientSecret: string; redirectUri: string; configured: true; missing: [] };
}

export async function startAuth(userId: string, purpose: 'import' | 'export', loginHint?: string) {
  const cfg = requireGoogle();
  const state = randomToken(24);
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  await q(`DELETE FROM oauth_states WHERE created_at < now() - interval '1 hour'`);
  await q('INSERT INTO oauth_states (state_hash, user_id, purpose, code_verifier) VALUES ($1,$2,$3,$4)', [
    createHash('sha256').update(state).digest('hex'), userId, purpose, encryptSecret(verifier),
  ]);
  const p = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code', access_type: 'offline', prompt: 'consent select_account',
    include_granted_scopes: 'true', scope: [...SCOPES.base, ...SCOPES[purpose]].join(' '), state, code_challenge: challenge, code_challenge_method: 'S256',
  });
  if (loginHint) p.set('login_hint', loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function consumeState(state: string) {
  const row = await q1<any>(
    `DELETE FROM oauth_states WHERE state_hash = $1 AND created_at > now() - interval '30 minutes' RETURNING *`,
    [createHash('sha256').update(state).digest('hex')],
  );
  if (!row) return null;
  return { userId: row.user_id as string, purpose: row.purpose as 'import' | 'export', verifier: decryptSecret(row.code_verifier) };
}

async function tokenRequest(body: Record<string, string>) {
  const cfg = requireGoogle();
  const res = await googleHttp.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...body }).toString(),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new HttpError(res.status === 400 ? 400 : 502, json.error === 'invalid_grant' ? 'google_reauth' : 'google_error', `Google sign-in failed: ${json.error_description ?? json.error ?? res.status}`);
    throw err;
  }
  return json as { access_token: string; refresh_token?: string; expires_in: number; scope: string; id_token?: string };
}

export async function completeAuth(userId: string, code: string, verifier: string) {
  const cfg = requireGoogle();
  const tok = await tokenRequest({ code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: cfg.redirectUri });
  const infoRes = await googleHttp.fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } });
  const info: any = await infoRes.json();
  if (!infoRes.ok || !info.sub) throw new HttpError(502, 'google_error', 'Could not read your Google account');
  const existing = await q1<any>('SELECT * FROM google_connections WHERE user_id = $1 AND google_sub = $2', [userId, info.sub]);
  const refreshEnc = tok.refresh_token ? encryptSecret(tok.refresh_token) : existing?.refresh_token_enc ?? null;
  if (!refreshEnc) throw new HttpError(400, 'google_error', 'Google did not grant offline access. Please try connecting again.');
  const scopes = [...new Set([...(existing?.scopes ?? '').split(' '), ...tok.scope.split(' ')].filter(Boolean))].join(' ');
  const conn = await q1<any>(
    `INSERT INTO google_connections (user_id, google_sub, google_email, access_token_enc, refresh_token_enc, token_expires_at, scopes, status, last_error)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6), $7, 'active', NULL)
     ON CONFLICT (user_id, google_sub) DO UPDATE SET google_email = EXCLUDED.google_email, access_token_enc = EXCLUDED.access_token_enc,
       refresh_token_enc = EXCLUDED.refresh_token_enc, token_expires_at = EXCLUDED.token_expires_at, scopes = EXCLUDED.scopes,
       status = 'active', last_error = NULL, updated_at = now()
     RETURNING *`,
    [userId, info.sub, info.email ?? 'unknown', encryptSecret(tok.access_token), refreshEnc, Math.max(60, tok.expires_in - 60), scopes],
  );
  await syncCalendarList(conn);
  return conn;
}

/** Returns a valid access token, refreshing it if needed. Tokens never leave the server. */
export async function accessToken(conn: any): Promise<string> {
  if (conn.status === 'disconnected' || !conn.refresh_token_enc) throw new HttpError(400, 'google_disconnected', 'This Google account is disconnected');
  if (conn.access_token_enc && conn.token_expires_at && new Date(conn.token_expires_at).getTime() > Date.now() + 30_000) return decryptSecret(conn.access_token_enc);
  try {
    const tok = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decryptSecret(conn.refresh_token_enc) });
    await q(`UPDATE google_connections SET access_token_enc = $2, token_expires_at = now() + make_interval(secs => $3), status = 'active', last_error = NULL, updated_at = now() WHERE id = $1`, [
      conn.id, encryptSecret(tok.access_token), Math.max(60, tok.expires_in - 60),
    ]);
    return tok.access_token;
  } catch (e) {
    if (e instanceof HttpError && e.code === 'google_reauth') {
      await q(`UPDATE google_connections SET status = 'needs_reauth', last_error = 'Access was revoked or expired', updated_at = now() WHERE id = $1`, [conn.id]);
      throw new HttpError(401, 'google_reauth', `Google access for ${conn.google_email} expired. Please reconnect this account.`);
    }
    throw e;
  }
}

async function gapi(conn: any, path: string, init: RequestInit = {}) {
  const token = await accessToken(conn);
  const res = await googleHttp.fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) await q(`UPDATE google_connections SET status = 'needs_reauth', last_error = $2 WHERE id = $1`, [conn.id, msg]);
    throw new HttpError(res.status === 403 ? 403 : 502, 'google_error', `Google Calendar: ${msg}`);
  }
  return json;
}

export async function syncCalendarList(conn: any) {
  const items: any[] = [];
  let pageToken: string | undefined;
  do {
    const r = await gapi(conn, `/users/me/calendarList?maxResults=250${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`);
    items.push(...(r.items ?? []));
    pageToken = r.nextPageToken;
  } while (pageToken);
  for (const cal of items) {
    await q(
      `INSERT INTO google_calendars (connection_id, google_calendar_id, summary, color, access_role, is_primary)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (connection_id, google_calendar_id) DO UPDATE SET summary = EXCLUDED.summary, color = EXCLUDED.color,
         access_role = EXCLUDED.access_role, is_primary = EXCLUDED.is_primary`,
      [conn.id, cal.id, cal.summaryOverride ?? cal.summary ?? cal.id, cal.backgroundColor ?? null, cal.accessRole ?? 'reader', Boolean(cal.primary)],
    );
  }
  return items.length;
}

export interface SourceSnapshot {
  title: string;
  description: string;
  location: string;
  all_day: boolean;
  start_date: string;
  end_date: string | null;
  starts_at: string | null;
  ends_at: string | null;
  participants: string[];
  restricted: boolean;          // private/confidential or details hidden by Google
  recurring_event_id: string | null;
  recurrence: string[] | null;
  status: string;
  updated: string | null;
}

export function normalizeGoogleEvent(ev: any, tz: string): SourceSnapshot {
  const allDay = Boolean(ev.start?.date);
  let start_date: string, end_date: string | null, starts_at: string | null = null, ends_at: string | null = null;
  if (allDay) {
    start_date = ev.start.date;
    end_date = ev.end?.date ? addDays(ev.end.date, -1) : start_date; // Google's end date is exclusive
    if (end_date < start_date) end_date = start_date;
  } else {
    starts_at = new Date(ev.start.dateTime).toISOString();
    ends_at = ev.end?.dateTime ? new Date(ev.end.dateTime).toISOString() : null;
    start_date = utcToZoned(new Date(starts_at), tz).date;
    end_date = ends_at ? utcToZoned(new Date(ends_at), tz).date : start_date;
  }
  const restricted = ev.visibility === 'private' || ev.visibility === 'confidential' || ev.summary === undefined;
  return {
    title: ev.summary ?? 'Busy',
    description: ev.description ?? '',
    location: ev.location ?? '',
    all_day: allDay,
    start_date, end_date, starts_at, ends_at,
    participants: (ev.attendees ?? []).filter((x: any) => !x.resource).map((x: any) => x.displayName ?? x.email).filter(Boolean).slice(0, 50),
    restricted,
    recurring_event_id: ev.recurringEventId ?? null,
    recurrence: ev.recurrence ?? null,
    status: ev.status ?? 'confirmed',
    updated: ev.updated ?? null,
  };
}

/** Read events from now (start of today in tz) through six months ahead. Expands recurring events. */
export async function listCalendarEvents(conn: any, calendarId: string, timeMin: Date, timeMax: Date) {
  const out: any[] = [];
  let pageToken: string | undefined;
  do {
    const p = new URLSearchParams({
      singleEvents: 'true', orderBy: 'startTime', maxResults: '250', timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString(), showDeleted: 'false',
    });
    if (pageToken) p.set('pageToken', pageToken);
    const r = await gapi(conn, `/calendars/${encodeURIComponent(calendarId)}/events?${p}`);
    out.push(...(r.items ?? []));
    pageToken = r.nextPageToken;
    if (out.length > 2500) break;
  } while (pageToken);
  return out.filter((e) => e.status !== 'cancelled' && e.eventType !== 'workingLocation');
}

export async function insertGoogleEvent(conn: any, calendarId: string, body: Record<string, unknown>) {
  if (!String(conn.scopes).split(' ').includes(WRITE_SCOPE)) {
    throw new HttpError(403, 'google_scope', 'Adding events needs extra permission for this Google account. Choose “Allow adding events” first.');
  }
  return gapi(conn, `/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

export async function revokeConnection(conn: any) {
  for (const enc of [conn.refresh_token_enc, conn.access_token_enc]) {
    if (!enc) continue;
    try {
      await googleHttp.fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(decryptSecret(enc))}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
      break;
    } catch { /* best effort: tokens are deleted locally regardless */ }
  }
}
