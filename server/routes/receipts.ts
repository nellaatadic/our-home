import { Hono } from 'hono';
import { z } from 'zod';
import { q, q1 } from '../db.js';
import { rateLimit, requireAuth } from '../lib/auth.js';
import { loadEntity, workspaceFor, type AppEnv, type Auth } from '../lib/access.js';
import { badRequest, dateStr, parse, space, uuid } from '../lib/http.js';
import { logActivity } from '../lib/notify.js';
import { todayIn } from '../lib/time.js';
import { aiConfigured, readReceiptAI } from '../lib/ai.js';
import { bestMatch, parseReceiptText, type ParsedLine } from '../lib/receipts.js';
import { readUpload, storeAttachment } from './attachments.js';

export const receiptRoutes = new Hono<AppEnv>();

async function groceryCategories(ws: string) {
  return q<{ id: string; name: string }>(`SELECT id, name FROM categories WHERE workspace_id = $1 AND module = 'grocery' ORDER BY sort_order`, [ws]);
}

async function matchLines(ws: string, receiptId: string) {
  const [needs, stock] = await Promise.all([
    q<any>(`SELECT id, title FROM items WHERE workspace_id = $1 AND module = 'grocery' AND grocery_state = 'need' AND archived_at IS NULL`, [ws]),
    q<any>(`SELECT id, title FROM items WHERE workspace_id = $1 AND module = 'grocery' AND grocery_state = 'stock' AND archived_at IS NULL`, [ws]),
  ]);
  const lines = await q<any>('SELECT * FROM receipt_lines WHERE receipt_id = $1 ORDER BY position', [receiptId]);
  for (const l of lines) {
    const need = bestMatch(l.name, needs);
    const st = bestMatch(l.name, stock);
    await q('UPDATE receipt_lines SET matched_need_item_id = $2, matched_stock_item_id = $3 WHERE id = $1', [l.id, need?.id ?? null, st?.id ?? null]);
  }
}

async function receiptDetail(a: Auth, id: string) {
  const r = await loadEntity<any>(a, 'receipt', id);
  const lines = await q<any>(
    `SELECT rl.*, n.title AS matched_need_title, s.title AS matched_stock_title, s.quantity AS matched_stock_quantity
       FROM receipt_lines rl LEFT JOIN items n ON n.id = rl.matched_need_item_id LEFT JOIN items s ON s.id = rl.matched_stock_item_id
      WHERE rl.receipt_id = $1 ORDER BY rl.position`,
    [r.id],
  );
  const needs = await q(`SELECT id, title, quantity FROM items WHERE workspace_id = $1 AND module = 'grocery' AND grocery_state = 'need' AND archived_at IS NULL ORDER BY title`, [r.workspace_id]);
  return {
    receipt: { ...r, attachment_url: r.attachment_id ? `/api/attachments/${r.attachment_id}` : null, space: r.workspace_id === a.sharedWorkspaceId ? 'us' : 'me' },
    lines, open_need_items: needs, categories: await groceryCategories(r.workspace_id),
  };
}

/**
 * Upload a receipt photo/PDF (and/or pasted text). The result is ALWAYS a
 * draft in "review" status; nothing reaches STOCK until the user confirms.
 */
receiptRoutes.post('/spaces/:space/receipts', async (c) => {
  const a = requireAuth(c);
  const ws = workspaceFor(a, parse(space, c.req.param('space')));
  const form = await c.req.formData();
  const text = String(form.get('text') ?? '').slice(0, 20000);
  const file = form.get('file');
  const up = file instanceof File && file.size > 0 ? await readUpload(file) : null;
  if (!up && !text.trim()) throw badRequest('Upload a receipt photo or PDF, or paste the receipt text');

  const cats = await groceryCategories(ws);
  let parsed: { merchant: string | null; purchase_date: string | null; total_cents: number | null; tax_cents: number | null; currency?: string | null; lines: ParsedLine[] } | null = null;
  let processor: 'ai' | 'text' | 'manual' = 'manual';
  let note: string | null = null;

  if (up && aiConfigured() && up.type !== 'image/heic') {
    try {
      await rateLimit(`ai:${a.user.id}`, 60, 3600);
      const ai = await readReceiptAI(up, cats.map((x) => x.name));
      if (ai) {
        processor = 'ai';
        const toCents = (n: number | null) => (n == null ? null : Math.round(n * 100));
        parsed = {
          merchant: ai.merchant, purchase_date: ai.purchase_date && /^\d{4}-\d{2}-\d{2}$/.test(ai.purchase_date) ? ai.purchase_date : null,
          total_cents: toCents(ai.total), tax_cents: toCents(ai.tax), currency: ai.currency && /^[A-Z]{3}$/.test(ai.currency) ? ai.currency : null,
          lines: ai.lines.map((l) => ({
            raw_text: l.raw_text, name: l.name, quantity: l.quantity, unit_price_cents: toCents(l.unit_price), total_cents: toCents(l.total_price),
            needs_review: !l.confident || !l.name.trim(), review_reason: !l.confident ? 'Hard to read — please check' : null, category_guess: l.category_guess,
          })),
        };
      } else note = 'The receipt could not be read automatically.';
    } catch (e) {
      console.error('receipt ai failed', (e as Error).message);
      note = 'Receipt recognition is unavailable right now.';
    }
  } else if (up && !aiConfigured()) {
    note = 'Automatic receipt reading is not configured (ANTHROPIC_API_KEY). Paste the receipt text or add items below.';
  }
  if (!parsed && text.trim()) {
    parsed = parseReceiptText(text);
    processor = 'text';
  }

  const receipt = await q1<any>(
    `INSERT INTO receipts (workspace_id, uploaded_by, processor, processor_note, merchant, purchase_date, total_cents, tax_cents, currency)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [ws, a.user.id, processor, note, parsed?.merchant ?? null, parsed?.purchase_date ?? null, parsed?.total_cents ?? null, parsed?.tax_cents ?? null,
      parsed?.currency ?? a.household.currency],
  );
  if (up) {
    const att = await storeAttachment(ws, 'receipt', receipt.id, a.user.id, up);
    await q('UPDATE receipts SET attachment_id = $1 WHERE id = $2', [att.id, receipt.id]);
  }
  let pos = 0;
  for (const l of parsed?.lines ?? []) {
    const cat = l.category_guess ? cats.find((x) => x.name.toLowerCase() === l.category_guess!.toLowerCase()) : null;
    await q(
      `INSERT INTO receipt_lines (receipt_id, position, raw_text, name, quantity, unit_price_cents, total_cents, category_id, needs_review, review_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [receipt.id, pos++, l.raw_text, l.name.slice(0, 200), l.quantity, l.unit_price_cents, l.total_cents, cat?.id ?? null, l.needs_review, l.review_reason],
    );
  }
  await matchLines(ws, receipt.id);
  return c.json(await receiptDetail(a, receipt.id), 201);
});

receiptRoutes.get('/spaces/:space/receipts', async (c) => {
  const a = requireAuth(c);
  const ws = workspaceFor(a, parse(space, c.req.param('space')));
  const rows = await q(
    `SELECT r.*, (SELECT count(*)::int FROM receipt_lines WHERE receipt_id = r.id) AS line_count FROM receipts r
      WHERE workspace_id = $1 AND status <> 'discarded' ORDER BY created_at DESC LIMIT 100`,
    [ws],
  );
  return c.json({ receipts: rows });
});

receiptRoutes.get('/receipts/:id', async (c) => {
  const a = requireAuth(c);
  return c.json(await receiptDetail(a, c.req.param('id')));
});

const lineInput = z.object({
  name: z.string().trim().max(200),
  quantity: z.number().min(0).max(1e6).nullish(),
  unit_price_cents: z.number().int().min(0).max(1e9).nullish(),
  total_cents: z.number().int().min(0).max(1e9).nullish(),
  category_id: uuid.nullish(),
  action: z.enum(['stock', 'skip']),
  complete_need_item_id: uuid.nullish(),   // mark this NEED item as purchased (moves it to STOCK)
  merge_into_stock_id: uuid.nullish(),     // add quantity to an existing STOCK item instead of a new one
  raw_text: z.string().max(500).nullish(),
});

/** Confirm the reviewed receipt: approved lines go to STOCK; matching NEED items are completed. */
receiptRoutes.post('/receipts/:id/confirm', async (c) => {
  const a = requireAuth(c);
  const r = await loadEntity<any>(a, 'receipt', c.req.param('id'));
  if (r.status !== 'review') throw badRequest('This receipt was already confirmed');
  const b = parse(
    z.object({
      merchant: z.string().trim().max(120).nullish(),
      purchase_date: dateStr.nullish(),
      total_cents: z.number().int().min(0).max(1e10).nullish(),
      lines: z.array(lineInput).max(300),
      create_expense: z.boolean().default(false),
      expense_split: z.enum(['individual', 'equal']).default('equal'),
    }),
    await c.req.json(),
  );
  const ws = r.workspace_id;
  const date = b.purchase_date ?? r.purchase_date ?? todayIn(a.household.timezone);
  const list = await q1<any>(`SELECT id FROM lists WHERE workspace_id = $1 AND module = 'grocery' AND is_default`, [ws]);
  const validCats = new Set((await groceryCategories(ws)).map((x) => x.id));
  for (const l of b.lines) if (l.action === 'stock' && !l.name) throw badRequest('Every line added to STOCK needs a name');

  await q('DELETE FROM receipt_lines WHERE receipt_id = $1', [r.id]);
  let added = 0, completed = 0, merged = 0, pos = 0;
  for (const l of b.lines) {
    const cat = l.category_id && validCats.has(l.category_id) ? l.category_id : null;
    await q(
      `INSERT INTO receipt_lines (receipt_id, position, raw_text, name, quantity, unit_price_cents, total_cents, category_id, matched_need_item_id, matched_stock_item_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [r.id, pos++, l.raw_text ?? null, l.name, l.quantity ?? null, l.unit_price_cents ?? null, l.total_cents ?? null, cat, l.complete_need_item_id ?? null, l.merge_into_stock_id ?? null],
    );
    if (l.action !== 'stock') continue;
    const qty = l.quantity ?? 1;
    if (l.complete_need_item_id) {
      const need = await q1<any>(`SELECT * FROM items WHERE id = $1 AND workspace_id = $2 AND module = 'grocery' AND grocery_state = 'need' AND archived_at IS NULL`, [l.complete_need_item_id, ws]);
      if (!need) throw badRequest(`“${l.name}”: that NEED item no longer exists`);
      if (l.merge_into_stock_id) {
        await mergeIntoStock(a, ws, l.merge_into_stock_id, qty, date);
        await q('UPDATE items SET archived_at = now(), updated_at = now() WHERE id = $1', [need.id]);
        merged++;
      } else {
        await q(
          `UPDATE items SET grocery_state = 'stock', quantity = $2, purchased_on = $3, price_cents = COALESCE($4, price_cents), category_id = COALESCE(category_id, $5),
             updated_at = now(), updated_by = $6 WHERE id = $1`,
          [need.id, qty, date, l.total_cents ?? null, cat, a.user.id],
        );
      }
      await logActivity(ws, 'item', need.id, a.user.id, 'purchased', `Purchased (receipt${r.merchant ? ` from ${r.merchant}` : ''})`);
      completed++;
      continue;
    }
    if (l.merge_into_stock_id) {
      await mergeIntoStock(a, ws, l.merge_into_stock_id, qty, date);
      merged++;
      continue;
    }
    const item = await q1<any>(
      `INSERT INTO items (workspace_id, list_id, module, grocery_state, title, quantity, category_id, price_cents, currency, purchased_on, store, created_by, updated_by)
       VALUES ($1,$2,'grocery','stock',$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id`,
      [ws, list.id, l.name, qty, cat, l.total_cents ?? null, r.currency, date, b.merchant ?? r.merchant, a.user.id],
    );
    await logActivity(ws, 'item', item.id, a.user.id, 'created', `Added from receipt${r.merchant ? ` (${r.merchant})` : ''}`);
    added++;
  }
  await q(`UPDATE receipts SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2, merchant = COALESCE($3, merchant), purchase_date = $4, total_cents = COALESCE($5, total_cents) WHERE id = $1`, [
    r.id, a.user.id, b.merchant ?? null, date, b.total_cents ?? null,
  ]);
  let expense_id: string | null = null;
  if (b.create_expense) {
    const amount = b.total_cents ?? r.total_cents ?? b.lines.filter((l) => l.action === 'stock').reduce((s, l) => s + (l.total_cents ?? 0), 0);
    const split = ws === a.sharedWorkspaceId ? b.expense_split : 'individual';
    const ex = await q1<any>(
      `INSERT INTO expenses (workspace_id, title, amount_cents, currency, purchase_date, purchaser_id, category, receipt_id, split_mode, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'Groceries',$7,$8,$6) RETURNING id`,
      [ws, `Groceries${b.merchant ?? r.merchant ? ` — ${b.merchant ?? r.merchant}` : ''}`, amount, r.currency ?? a.household.currency, date, a.user.id, r.id, split],
    );
    if (split === 'equal' && a.members.length > 1) {
      const share = Math.floor(amount / a.members.length);
      for (const [i, m] of a.members.entries()) {
        await q('INSERT INTO expense_allocations (expense_id, user_id, amount_cents) VALUES ($1,$2,$3)', [ex.id, m.id, i === 0 ? amount - share * (a.members.length - 1) : share]);
      }
    }
    expense_id = ex.id;
  }
  return c.json({ added, completed, merged, expense_id });
});

async function mergeIntoStock(a: Auth, ws: string, stockId: string, qty: number, date: string) {
  const row = await q1(
    `UPDATE items SET quantity = COALESCE(quantity, 0) + $3, purchased_on = $4, updated_at = now(), updated_by = $5
      WHERE id = $1 AND workspace_id = $2 AND module = 'grocery' AND grocery_state = 'stock' AND archived_at IS NULL RETURNING id`,
    [stockId, ws, qty, date, a.user.id],
  );
  if (!row) throw badRequest('That STOCK item no longer exists');
}

receiptRoutes.post('/receipts/:id/discard', async (c) => {
  const a = requireAuth(c);
  const r = await loadEntity<any>(a, 'receipt', c.req.param('id'));
  if (r.status !== 'review') throw badRequest('Only receipts awaiting review can be discarded');
  await q(`UPDATE receipts SET status = 'discarded' WHERE id = $1`, [r.id]);
  return c.json({ ok: true });
});
