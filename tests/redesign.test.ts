import { beforeAll, describe, expect, it } from 'vitest';
import { Client, household, resetDb } from './helpers.js';
import { yearlyOccurrences } from '../server/routes/events.js';

beforeAll(resetDb);

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], 'p.png', { type: 'image/png' });

describe('Defaults', () => {
  it('creates new households in Toronto time with Canadian dollars', async () => {
    const c = new Client('solo');
    await c.ok('POST', '/auth/register', { email: 'solo@example.test', password: 'correct horse battery', display_name: 'Solo' });
    const me = await c.ok('GET', '/auth/me');
    expect(me.household.timezone).toBe('America/Toronto');
    expect(me.household.currency).toBe('CAD');
  });
});

describe('Lists: shared unless locked', () => {
  it('adds to US by default and keeps locked items away from the partner', async () => {
    const { me, you } = await household();
    const eggs = (await me.ok('POST', '/modules/grocery/items', { title: 'Eggs' })).item;
    expect(eggs.space).toBe('us');
    expect(eggs.private).toBe(false);
    const gift = (await me.ok('POST', '/modules/idea/items', { title: 'Watch for Zsolt', private: true })).item;
    expect(gift.private).toBe(true);

    const theirs = (await you.ok('GET', '/modules/grocery/items')).items.map((i: any) => i.title);
    expect(theirs).toContain('Eggs');
    expect(JSON.stringify(await you.ok('GET', '/modules/idea/items'))).not.toContain('Watch');
    expect((await you.get(`/items/${gift.id}`)).status).toBe(404);
  });

  it('moves a locked item together with its chat, photos and subtasks', async () => {
    const { me, you } = await household();
    const lamp = (await me.ok('POST', '/modules/home/items', { title: 'Floor lamp' })).item;
    await me.ok('POST', `/threads/item/${lamp.id}/messages`, { body: '@Zsolt this one?' });
    await me.ok('POST', `/items/${lamp.id}/subtasks`, { title: 'Measure corner' });
    const fd = new FormData();
    fd.set('entity_type', 'item'); fd.set('entity_id', lamp.id); fd.set('file', png());
    const att = (await me.ok('POST', '/attachments', fd)).attachment;
    expect((await you.ok('GET', '/notifications')).notifications.some((n: any) => n.entity_id === lamp.id)).toBe(true);

    // Only the person who added it can lock it.
    expect((await you.post(`/items/${lamp.id}/privacy`, { private: true })).status).toBe(403);
    const locked = (await me.ok('POST', `/items/${lamp.id}/privacy`, { private: true })).item;
    expect(locked.private).toBe(true);

    expect((await you.get(`/items/${lamp.id}`)).status).toBe(404);
    expect((await you.get(`/threads/item/${lamp.id}`)).status).toBe(404);
    expect((await you.get(`/attachments/${att.id}`)).status).toBe(404);
    expect((await you.ok('GET', '/notifications')).notifications.some((n: any) => n.entity_id === lamp.id)).toBe(false);
    expect(JSON.stringify(await you.ok('GET', '/chat/cards'))).not.toContain('Floor lamp');
    const sub = (await me.ok('GET', `/items/${lamp.id}`)).item.subtask_list[0];
    expect((await you.patch(`/subtasks/${sub.id}`, { done: true })).status).toBe(404);
    // Still all there for me.
    expect((await me.ok('GET', `/threads/item/${lamp.id}`)).messages).toHaveLength(1);
    expect((await me.get(`/attachments/${att.id}`)).status).toBe(200);

    await me.ok('POST', `/items/${lamp.id}/privacy`, { private: false });
    expect((await you.get(`/items/${lamp.id}`)).status).toBe(200);
  });

  it('gives Home & Gadgets and Shopping & Other the same NEED / STOCK flow', async () => {
    const { me } = await household();
    const drill = (await me.ok('POST', '/modules/home/items', { title: 'Drill' })).item;
    expect(drill.grocery_state).toBe('need');
    const bought = (await me.ok('POST', `/items/${drill.id}/purchase`, {})).item;
    expect(bought.grocery_state).toBe('stock');
    await me.ok('POST', `/items/${drill.id}/need`, {});
    const r = await me.ok('GET', '/modules/home/items?state=need');
    expect(r.items.map((i: any) => i.id)).toEqual([drill.id]);
    expect(r.counts).toEqual({ need: 1, stock: 0 });
  });

  it('filters by search, category and flags', async () => {
    const { me } = await household();
    const cats = (await me.ok('GET', '/modules/grocery/categories')).categories;
    const dairy = cats.find((c: any) => c.name === 'Dairy');
    await me.ok('POST', '/modules/grocery/items', { title: 'Milk', category_id: dairy.id, flagged: true });
    await me.ok('POST', '/modules/grocery/items', { title: 'Bread' });
    expect((await me.ok('GET', '/modules/grocery/items?q=mil')).items.map((i: any) => i.title)).toEqual(['Milk']);
    expect((await me.ok('GET', '/modules/grocery/items?category=Dairy')).items.map((i: any) => i.title)).toEqual(['Milk']);
    expect((await me.ok('GET', '/modules/grocery/items?flagged=true')).items.map((i: any) => i.title)).toEqual(['Milk']);
  });

  it('moves an item to another list and keeps a repeating item on NEED', async () => {
    const { me } = await household();
    const it1 = (await me.ok('POST', '/modules/grocery/items', { title: 'Batteries' })).item;
    const moved = (await me.ok('PATCH', `/items/${it1.id}`, { module: 'home' })).item;
    expect(moved.module).toBe('home');
    const milk = (await me.ok('POST', '/modules/grocery/items', { title: 'Milk', due_date: '2026-11-20', repeat_unit: 'week' })).item;
    const after = await me.ok('POST', `/items/${milk.id}/purchase`, {});
    expect(after.repeated).toBe(true);
    expect(after.item.grocery_state).toBe('need');
    expect(after.item.due_date).toBe('2026-11-27');
  });

  it('turns a dated item into a reminder notification', async () => {
    const { me, you } = await household();
    const it1 = (await me.ok('POST', '/modules/grocery/items', { title: 'Pick up cake', due_date: '2026-01-02', due_time: '14:00', urgent: true })).item;
    expect(it1.reminder_at).toBeTruthy();
    await me.ok('GET', '/dashboard');
    for (const c of [me, you]) {
      expect((await c.ok('GET', '/notifications')).notifications.some((n: any) => n.type === 'reminder' && n.entity_id === it1.id)).toBe(true);
    }
  });
});

describe('Chat', () => {
  it('has one general chat with card references, and conversation cards', async () => {
    const { me, you } = await household();
    const g1 = (await me.ok('GET', '/chat/general')).topic;
    const g2 = (await you.ok('GET', '/chat/general')).topic;
    expect(g1.id).toBe(g2.id);
    const sofa = (await me.ok('POST', '/modules/home/items', { title: 'Grey sofa' })).item;
    const secret = (await me.ok('POST', '/modules/idea/items', { title: 'Secret present', private: true })).item;

    const refs = (await me.ok('GET', '/chat/references?q=s')).references.map((r: any) => r.title);
    expect(refs).toContain('Grey sofa');
    expect(refs).not.toContain('Secret present');

    await me.ok('POST', `/threads/topic/${g1.id}/messages`, { body: `What about @[Grey sofa](item:${sofa.id})?` });
    expect((await you.ok('GET', `/threads/topic/${g1.id}`)).messages[0].body).toContain(`item:${sofa.id}`);
    expect((await you.ok('GET', '/chat/unread')).unread).toBe(1);

    await you.ok('POST', `/threads/item/${sofa.id}/messages`, { body: 'Love it' });
    await me.ok('POST', `/threads/item/${secret.id}/messages`, { body: 'Order by Friday' });
    const cards = (await you.ok('GET', '/chat/cards')).cards;
    expect(cards.map((c: any) => c.title)).toEqual(['Grey sofa']);
    expect((await me.ok('GET', '/chat/cards')).cards.map((c: any) => c.title).sort()).toEqual(['Grey sofa', 'Secret present']);
  });

  it('creates topics, private ones only for their creator', async () => {
    const { me, you } = await household();
    const t = (await me.ok('POST', '/chat/topics', { title: 'Holiday plans' })).topic;
    const p = (await me.ok('POST', '/chat/topics', { title: 'Anniversary surprise', private: true })).topic;
    expect((await you.ok('GET', '/chat/cards')).cards.map((c: any) => c.title)).toEqual(['Holiday plans']);
    expect((await you.get(`/threads/topic/${p.id}`)).status).toBe(404);
    await you.ok('POST', `/threads/topic/${t.id}/messages`, { body: 'Portugal?' });
    expect((await me.ok('GET', '/notifications')).notifications.some((n: any) => n.entity_id === t.id && /wrote in/.test(n.title))).toBe(true);
  });
});

describe('Calendar', () => {
  it('repeats birthdays every year and lists them as important dates', async () => {
    expect(yearlyOccurrences('2000-02-29', '2027-01-01', '2028-12-31')).toEqual(['2027-02-28', '2028-02-29']);
    const { me } = await household({ timezone: 'America/Toronto' });
    const today = (await me.ok('GET', '/dashboard')).today as string;
    const bday = `1990-${today.slice(5, 7)}-28`;
    await me.ok('POST', '/spaces/us/events', { title: 'Zsolt’s birthday', date: bday, all_day: true, category: 'Birthday', yearly: true });
    const y = today.slice(0, 4);
    const r = await me.ok('GET', `/events?from=${y}-${today.slice(5, 7)}-01&to=${y}-${today.slice(5, 7)}-28`);
    const occ = r.events.find((e: any) => e.title === 'Zsolt’s birthday');
    expect(occ.start_date).toBe(`${y}-${today.slice(5, 7)}-28`);
    expect(occ.years).toBe(Number(y) - 1990);
    if (today <= `${y}-${today.slice(5, 7)}-28`) {
      expect((await me.ok('GET', '/dashboard')).important_dates.map((e: any) => e.title)).toContain('Zsolt’s birthday');
    }
  });

  it('shows the partner’s private time as Busy only after they opt in', async () => {
    const { me, you } = await household();
    await you.ok('POST', '/spaces/me/events', { title: 'Therapy', date: '2026-12-03', start_time: '15:00', end_time: '16:00', location: 'Downtown' });
    const before = await me.ok('GET', '/events?from=2026-12-01&to=2026-12-07&busy=true');
    expect(before.busy).toEqual([]);
    await you.ok('PATCH', '/household/settings', { share_availability: true });
    const after = await me.ok('GET', '/events?from=2026-12-01&to=2026-12-07&busy=true');
    expect(after.busy).toHaveLength(1);
    expect(after.busy[0]).toMatchObject({ start_date: '2026-12-03', start_time: '15:00', end_time: '16:00' });
    expect(JSON.stringify(after)).not.toMatch(/Therapy|Downtown/);
  });
});

describe('Dashboard and data', () => {
  it('respects widget settings', async () => {
    const { me } = await household();
    for (const t of ['A', 'B', 'C', 'D']) await me.ok('POST', '/modules/grocery/items', { title: t });
    await me.ok('PATCH', '/household/settings', { dashboard: { widgets: { grocery: { max: 2, size: 'l' } } } });
    const d = await me.ok('GET', '/dashboard');
    expect(d.lists.grocery.items).toHaveLength(2);
    expect(d.lists.grocery.need).toBe(4);
    expect(d.prefs.widgets.grocery).toEqual({ max: 2, size: 'l' });
    expect(d.prefs.widgets.home.max).toBe(5);
  });

  it('computes spending and habits from what the viewer may see', async () => {
    const { me, you } = await household();
    const month = (await me.ok('GET', '/dashboard')).today.slice(0, 7);
    await me.ok('POST', '/spaces/us/expenses', { title: 'Couch', amount_cents: 80000, purchase_date: `${month}-01`, category: 'Home', split_mode: 'equal' });
    await you.ok('POST', '/spaces/me/expenses', { title: 'Private thing', amount_cents: 99999, purchase_date: `${month}-01` });
    const milk = (await me.ok('POST', '/modules/grocery/items', { title: 'Milk' })).item;
    await me.ok('POST', `/items/${milk.id}/purchase`, {});
    const d = await me.ok('GET', '/data');
    expect(d.spending.total_cents).toBe(80000);
    expect(d.spending.balance).toEqual({ owed_to: 'Nella', owed_by: 'Zsolt', cents: 40000 });
    expect(d.groceries.most_bought).toEqual([{ title: 'Milk', n: 1 }]);
    expect(d.calendar.weeks).toHaveLength(8);
  });
});
