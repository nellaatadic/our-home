import { beforeAll, describe, expect, it } from 'vitest';
import { household, resetDb } from './helpers.js';
import { parseReceiptText, matchScore } from '../server/lib/receipts.js';
import { assertSafeUrl, isPublicIp, parseMeta } from '../server/lib/linkpreview.js';
import { zonedToUtc, utcToZoned, addMonths } from '../server/lib/time.js';

beforeAll(resetDb);

const RECEIPT = `FRESH MARKET
2026-11-14 18:22
WHOLE MILK 1L          1.29
2 x SOURDOUGH BREAD    5.00
BANANAS 1.2 kg x 1.50  1.80
#*                     0.99
SUBTOTAL               9.08
VAT                    1.20
TOTAL                  9.08
VISA ****1234          9.08`;

describe('Scenario F — grocery receipt', () => {
  it('reviews lines, corrects one, adds to STOCK and completes matching NEED items', async () => {
    const { me, you } = await household();
    const milk = (await me.ok('POST', '/spaces/us/items', { module: 'grocery', title: 'Milk', quantity: 2 })).item;
    const eggs = (await me.ok('POST', '/spaces/us/items', { module: 'grocery', title: 'Eggs' })).item;
    const fd = new FormData();
    fd.set('text', RECEIPT);
    const draft = await me.ok('POST', '/spaces/us/receipts', fd);
    expect(draft.receipt.status).toBe('review');
    expect(draft.receipt.merchant).toBe('FRESH MARKET');
    expect(draft.receipt.purchase_date).toBe('2026-11-14');
    expect(draft.receipt.total_cents).toBe(908);
    const names = draft.lines.map((l: any) => l.name);
    expect(names).toEqual(['Whole Milk 1l', 'Sourdough Bread', 'Bananas', '']);
    expect(draft.lines[1].quantity).toBe(2);
    expect(draft.lines[2].quantity).toBe(1.2);
    expect(draft.lines[3].needs_review).toBe(true); // unreadable line is flagged, not guessed
    expect(draft.lines[0].matched_need_item_id).toBe(milk.id);

    // Nothing in STOCK until confirmation
    expect((await me.ok('GET', '/spaces/us/items?module=grocery&state=stock')).items).toHaveLength(0);

    const lines = draft.lines.map((l: any, i: number) => ({
      name: i === 3 ? 'Chewing gum' : i === 2 ? 'Bananas (organic)' : l.name, // correction
      quantity: l.quantity, unit_price_cents: l.unit_price_cents, total_cents: l.total_cents, category_id: l.category_id,
      action: 'stock', complete_need_item_id: l.matched_need_item_id, merge_into_stock_id: null, raw_text: l.raw_text,
    }));
    const res = await me.ok('POST', `/receipts/${draft.receipt.id}/confirm`, { lines, create_expense: true, expense_split: 'equal' });
    expect(res).toMatchObject({ added: 3, completed: 1 });
    const stock = (await you.ok('GET', '/spaces/us/items?module=grocery&state=stock')).items;
    expect(stock.map((s: any) => s.title).sort()).toEqual(['Bananas (organic)', 'Chewing gum', 'Milk', 'Sourdough Bread']);
    const need = (await you.ok('GET', '/spaces/us/items?module=grocery&state=need')).items;
    expect(need.map((n: any) => n.id)).toEqual([eggs.id]); // milk was completed
    // expense recorded and split
    const ex = await you.ok('GET', '/spaces/us/expenses');
    expect(ex.expenses[0].amount_cents).toBe(908);
    expect(ex.expenses[0].allocations).toHaveLength(2);
    // cannot confirm twice
    expect((await me.post(`/receipts/${draft.receipt.id}/confirm`, { lines })).status).toBe(400);
  });

  it('stores an uploaded photo privately and asks for manual review when OCR is not configured', async () => {
    const { me, you } = await household();
    const fd = new FormData();
    fd.set('file', new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4])], 'receipt.jpg', { type: 'image/jpeg' }));
    const draft = await me.ok('POST', '/spaces/me/receipts', fd);
    expect(draft.receipt.processor).toBe('manual');
    expect(draft.receipt.processor_note).toMatch(/not configured/);
    expect(draft.lines).toHaveLength(0);
    expect((await me.get(draft.receipt.attachment_url.replace('/api', ''))).status).toBe(200);
    expect((await you.get(draft.receipt.attachment_url.replace('/api', ''))).status).toBe(404);
    expect((await you.get(`/receipts/${draft.receipt.id}`)).status).toBe(404);
  });
});

describe('Groceries NEED → STOCK', () => {
  it('moves purchased items to STOCK with an updated quantity, merges duplicates, and back', async () => {
    const { me } = await household();
    const cat = (await me.ok('GET', '/spaces/us/categories?module=grocery')).categories.find((c: any) => c.name === 'Dairy');
    const yog = (await me.ok('POST', '/spaces/us/items', { module: 'grocery', title: 'Yoghurt', quantity: 4, category_id: cat.id, priority: 'urgent' })).item;
    expect(yog.category.name).toBe('Dairy');
    const moved = (await me.ok('POST', `/items/${yog.id}/purchase`, { quantity: 6 })).item;
    expect(moved.grocery_state).toBe('stock');
    expect(moved.quantity).toBe(6);
    expect(moved.purchased_on).toMatch(/^\d{4}-/);
    const again = (await me.ok('POST', '/spaces/us/items', { module: 'grocery', title: 'Yoghurt', quantity: 2 })).item;
    const merged = await me.ok('POST', `/items/${again.id}/purchase`, { merge_into_id: yog.id });
    expect(merged.merged).toBe(true);
    expect(merged.item.quantity).toBe(8);
    const back = (await me.ok('POST', `/items/${yog.id}/need`, { quantity: 1 })).item;
    expect(back.grocery_state).toBe('need');
    // filtering and sorting
    const urgent = (await me.ok('GET', '/spaces/us/items?module=grocery&priority=urgent')).items;
    expect(urgent.map((i: any) => i.id)).toEqual([yog.id]);
    const byCat = (await me.ok('GET', `/spaces/us/items?module=grocery&category_id=${cat.id}&sort=priority`)).items;
    expect(byCat).toHaveLength(1);
  });

  it('supports home-improvement comparisons and decision states', async () => {
    const { me, you } = await household();
    const a = (await me.ok('POST', '/spaces/us/items', { module: 'home', title: 'Shelf A', room: 'Living room', price_cents: 12000, dimensions: '80×30×200 cm' })).item;
    const b = (await you.ok('POST', '/spaces/us/items', { module: 'home', title: 'Shelf B', room: 'Living room', price_cents: 9000 })).item;
    await me.ok('POST', `/items/${a.id}/compare`, { other_id: b.id });
    await you.ok('POST', `/items/${b.id}/prefer`);
    const d = await me.ok('GET', `/items/${a.id}`);
    expect(d.alternatives.map((x: any) => x.id)).toEqual([b.id]);
    expect(d.alternatives[0].purchase_stage).toBe('preferred');
    await me.ok('PATCH', `/items/${b.id}`, { decision_status: 'approved', purchase_stage: 'agreed', tags: ['living room', 'storage'] });
    const n = (await you.ok('GET', '/notifications')).notifications;
    expect(n.some((x: any) => x.type === 'decision' && x.entity_id === b.id)).toBe(true);
    const tagged = (await you.ok('GET', '/spaces/us/items?module=home&tag=storage')).items;
    expect(tagged.map((x: any) => x.id)).toEqual([b.id]);
  });

  it('records inventory and individual vs shared expenses with custom allocation', async () => {
    const { me, meId, youId } = await household();
    const inv = (await me.ok('POST', '/spaces/us/inventory', { name: 'Dishwasher', room: 'Kitchen', brand: 'Bosch', warranty_until: '2028-05-01', manual_url: 'https://example.com/manual.pdf' })).item;
    expect((await me.ok('GET', '/spaces/us/inventory?room=Kitchen')).inventory.map((x: any) => x.id)).toEqual([inv.id]);
    expect((await me.post('/spaces/us/expenses', { title: 'Sofa', amount_cents: 100000, purchase_date: '2026-11-01', split_mode: 'custom', allocations: [{ user_id: meId, amount_cents: 70000 }, { user_id: youId, amount_cents: 20000 }] })).status).toBe(400);
    await me.ok('POST', '/spaces/us/expenses', { title: 'Sofa', amount_cents: 100000, purchase_date: '2026-11-01', split_mode: 'custom', allocations: [{ user_id: meId, amount_cents: 70000 }, { user_id: youId, amount_cents: 30000 }] });
    await me.ok('POST', '/spaces/us/expenses', { title: 'Gym', amount_cents: 3000, purchase_date: '2026-11-02', split_mode: 'individual' });
    const t = (await me.ok('GET', '/spaces/us/expenses')).totals;
    expect(t.total).toBe(103000);
    expect(t.balance[meId]).toEqual({ paid: 100000, responsible: 70000 });
    expect(t.balance[youId]).toEqual({ paid: 0, responsible: 30000 });
  });
});

describe('unit: parsers, time and URL safety', () => {
  it('parses receipt text', () => {
    const r = parseReceiptText(RECEIPT);
    expect(r.lines).toHaveLength(4);
    expect(r.tax_cents).toBe(120);
  });
  it('matches receipt names to list items', () => {
    expect(matchScore('Whole Milk 1l', 'Milk')).toBe(1);
    expect(matchScore('Sourdough Bread', 'Milk')).toBe(0);
    expect(matchScore('Bananas', 'Banana')).toBe(1);
  });
  it('converts household-local times across DST', () => {
    expect(zonedToUtc('2026-07-01', '09:00', 'Europe/Budapest').toISOString()).toBe('2026-07-01T07:00:00.000Z');
    expect(zonedToUtc('2026-12-01', '09:00', 'Europe/Budapest').toISOString()).toBe('2026-12-01T08:00:00.000Z');
    expect(utcToZoned(new Date('2026-03-29T01:30:00Z'), 'Europe/Budapest').time).toBe('03:30');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
  });
  it('blocks private network addresses for link previews', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) expect(isPublicIp(ip)).toBe(false);
    expect(isPublicIp('93.184.216.34')).toBe(true);
    await expect(assertSafeUrl('http://localhost/admin')).rejects.toThrow();
    await expect(assertSafeUrl('http://169.254.169.254/latest')).rejects.toThrow();
    await expect(assertSafeUrl('file:///etc/passwd')).rejects.toThrow();
  });
  it('extracts product metadata', () => {
    const m = parseMeta(`<html><head><title>X</title><meta property="og:title" content="Oak shelf &amp; frame"><meta property="og:image" content="/img/a.jpg">
      <meta property="product:price:amount" content="129.90"><meta property="product:price:currency" content="eur"></head></html>`, new URL('https://shop.example/p/1'));
    expect(m).toMatchObject({ title: 'Oak shelf & frame', image_url: 'https://shop.example/img/a.jpg', price_cents: 12990, currency: 'EUR' });
  });
});
