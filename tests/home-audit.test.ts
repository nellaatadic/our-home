import { beforeAll, describe, expect, it } from 'vitest';
import { household, resetDb } from './helpers.js';

beforeAll(resetDb);

const activity = async (c: any) => (await c.ok('GET', '/notifications')).notifications.filter((n: any) => n.type === 'activity');

describe('Completed items and activity lines', () => {
  it('keeps a ticked item under Completed until both have seen it, and undo puts it back', async () => {
    const { me, you } = await household();
    const milk = (await me.ok('POST', '/modules/grocery/items', { title: 'Milk' })).item;
    await me.ok('POST', '/modules/grocery/items', { title: 'Eggs' });

    // Additions fold into one line for the partner.
    const added = await activity(you);
    expect(added).toHaveLength(1);
    expect(added[0].title).toBe('Nella added Milk and Eggs to @Groceries');
    expect(added[0].list_key).toBe('grocery');

    await me.ok('POST', `/items/${milk.id}/purchase`, {});
    const lines = await activity(you);
    expect(lines.map((n: any) => n.title)).toContain('Nella completed Milk in @Groceries');
    let dash = await me.ok('GET', '/dashboard');
    expect(dash.lists.grocery.completed.map((i: any) => i.title)).toEqual(['Milk']);

    // Undo: back on the list, and the partner's unseen "completed" line is withdrawn.
    await me.ok('POST', `/items/${milk.id}/uncomplete`);
    expect((await me.ok('GET', `/items/${milk.id}`)).item.grocery_state).toBe('need');
    expect((await activity(you)).map((n: any) => n.title)).not.toContain('Nella completed Milk in @Groceries');
    expect((await me.post(`/items/${milk.id}/uncomplete`)).status).toBe(400);

    // Ticked again; once the partner has read it (and a quarter of an hour passed) it leaves Completed.
    await me.ok('POST', `/items/${milk.id}/purchase`, {});
    const done = (await activity(you)).find((n: any) => n.title.includes('completed'));
    await you.ok('POST', '/notifications/read', { ids: [done.id] });
    dash = await me.ok('GET', '/dashboard');
    expect(dash.lists.grocery.completed.map((i: any) => i.title)).toEqual(['Milk']); // still within 15 minutes
  });

  it('tells the partner about urgent and removed items, never about private ones', async () => {
    const { me, you } = await household();
    const soap = (await me.ok('POST', '/modules/grocery/items', { title: 'Dish soap' })).item;
    await me.ok('PATCH', `/items/${soap.id}`, { urgent: true });
    await me.ok('POST', `/entities/item/${soap.id}/archive`);
    const titles = (await activity(you)).map((n: any) => n.title);
    expect(titles).toContain('Nella marked Dish soap as urgent in @Groceries');
    expect(titles).toContain('Nella removed Dish soap in @Groceries');

    const secret = (await me.ok('POST', '/modules/idea/items', { title: 'Surprise gift', private: true })).item;
    await me.ok('PATCH', `/items/${secret.id}`, { urgent: true });
    expect((await activity(you)).some((n: any) => n.title.includes('Surprise'))).toBe(false);
  });
});

describe('Home cards', () => {
  it('gives Important Dates and To do their own chat, emoji and colour', async () => {
    const { me, you } = await household();
    const dash = await me.ok('GET', '/dashboard');
    expect(dash.cards.dates.topic_id).toBeTruthy();
    expect((await you.ok('GET', '/dashboard')).cards.dates.topic_id).toBe(dash.cards.dates.topic_id);
    await me.ok('PATCH', '/home/cards/dates', { emoji: '🎂', color: '#cfb0b8' });
    expect((await you.ok('GET', '/dashboard')).cards.dates).toMatchObject({ emoji: '🎂', color: '#cfb0b8' });
    await me.ok('POST', `/threads/topic/${dash.cards.todos.topic_id}/messages`, { body: 'Who calls the plumber?' });
    expect((await you.ok('GET', '/dashboard')).cards.todos.unread).toBe(1);
    // The card topics can't be archived or renamed, and don't clutter the Chat page while empty.
    await me.ok('PATCH', `/topics/${dash.cards.dates.topic_id}`, { archived: true, title: 'x' });
    expect((await me.ok('GET', `/topics/${dash.cards.dates.topic_id}`)).topic).toMatchObject({ archived_at: null, title: 'Important Dates' });
    expect((await me.ok('GET', '/chat/cards')).cards.some((c: any) => c.title === 'Important Dates')).toBe(false);
    // Built-in lists can get another emoji and colour but keep their name.
    const nav = await me.ok('GET', '/lists/nav');
    await me.ok('PATCH', `/lists/${nav.builtin.grocery}`, { emoji: '🥬', color: '#9fcac0' });
    expect((await you.ok('GET', '/lists/nav')).builtin_style.grocery).toEqual({ emoji: '🥬', color: '#9fcac0' });
    expect((await me.patch(`/lists/${nav.builtin.grocery}`, { name: 'Food' })).status).toBe(400);
  });
});

describe('Sub lists and references', () => {
  it('moves an item onto an event’s own list and splits @ cards from # items', async () => {
    const { me } = await household();
    const ev = (await me.ok('POST', '/spaces/us/events', { title: 'Zsolt’s birthday', date: '2000-12-11', all_day: true, category: 'Birthday', yearly: true })).event;
    const sub = await me.ok('GET', '/sublists');
    const found = sub.events.find((e: any) => e.id === ev.id);
    expect(found.date.slice(5)).toBe('12-11');
    expect(found.date >= '2026-01-01').toBe(true);
    const list = (await me.ok('POST', '/lists', { name: 'For the birthday', event_id: ev.id })).list;
    const cake = (await me.ok('POST', '/modules/grocery/items', { title: 'Cake' })).item;
    await me.ok('PATCH', `/items/${cake.id}`, { module: 'custom', list_id: list.id });
    expect((await me.ok('GET', '/sublists')).events.find((e: any) => e.id === ev.id).lists[0].name).toBe('For the birthday');
    // A yearly event with a list is a plan that is never "over".
    const plans = (await me.ok('GET', '/plans')).plans;
    expect(plans.find((p: any) => p.id === ev.id)).toMatchObject({ over: false });

    const cards = (await me.ok('GET', '/chat/references?kind=cards&q=birthday')).references;
    expect(cards.every((r: any) => ['list', 'event', 'topic', 'pin'].includes(r.type))).toBe(true);
    expect(cards.some((r: any) => r.type === 'event')).toBe(true);
    const items = (await me.ok('GET', '/chat/references?kind=items&q=cake')).references;
    expect(items.map((r: any) => r.type)).toEqual(['item']);
  });
});

describe('Board stickies for items', () => {
  it('pins an item once, shows its details, and commits a floating idea to a list', async () => {
    const { me, you } = await household();
    const lamp = (await me.ok('POST', '/modules/home/items', { title: 'Lamp', notes: 'Brass, for the corner', tags: ['living-room'] })).item;
    expect((await me.ok('GET', '/board/candidates')).items.map((i: any) => i.title)).toContain('Lamp');
    const pin = (await me.ok('POST', '/pins', { item_id: lamp.id })).pin;
    expect(pin.title).toBe('Lamp');
    expect(pin.item).toMatchObject({ id: lamp.id, notes: 'Brass, for the corner', tags: ['living-room'], list: { key: 'home', name: 'Home & Gadgets' } });
    expect((await me.post('/pins', { item_id: lamp.id })).status).toBe(409);
    expect((await me.ok('GET', '/board/candidates')).items.map((i: any) => i.title)).not.toContain('Lamp');
    expect((await you.ok('GET', '/board')).pins.find((p: any) => p.id === pin.id).item.title).toBe('Lamp');

    // A private item makes a private sticky the partner never sees.
    const gift = (await me.ok('POST', '/modules/idea/items', { title: 'Watch', private: true })).item;
    const giftPin = (await me.ok('POST', '/pins', { item_id: gift.id })).pin;
    expect(giftPin.private).toBe(true);
    expect((await you.ok('GET', '/board')).pins.some((p: any) => p.id === giftPin.id)).toBe(false);
    expect((await you.post('/pins', { item_id: gift.id })).status).toBe(404);

    // A floating idea becomes an item on a list.
    const idea = (await you.ok('POST', '/pins', { kind: 'note', title: 'Raincoat', body: 'Yellow one' })).pin;
    expect(idea.item).toBeNull();
    const committed = await you.ok('POST', `/pins/${idea.id}/commit`, { list: 'idea' });
    expect(committed.item).toMatchObject({ title: 'Raincoat', notes: 'Yellow one', module: 'idea' });
    expect(committed.pin.item.list.key).toBe('idea');
    expect((await you.post(`/pins/${idea.id}/commit`, { list: 'idea' })).status).toBe(400);
  });
});

describe('Nicknames', () => {
  it('are only ever visible to the person who made them', async () => {
    const { me, you, youId, meId } = await household();
    const rule = (await me.ok('POST', '/nicknames', { target_id: youId, name: 'Big Friday', rule: 'weekly', weekday: 5 })).nickname;
    await me.ok('POST', '/nicknames', { target_id: youId, name: 'Birthday Boy', rule: 'yearly', month_day: '12-11' });
    expect((await me.ok('GET', '/nicknames')).nicknames.map((n: any) => n.name)).toEqual(['Big Friday', 'Birthday Boy']);
    expect((await you.ok('GET', '/nicknames')).nicknames).toEqual([]);
    expect((await you.del(`/nicknames/${rule.id}`)).status).toBe(404);
    expect((await me.post('/nicknames', { target_id: youId, name: 'X', rule: 'weekly' })).status).toBe(400);
    expect((await me.post('/nicknames', { target_id: '00000000-0000-4000-8000-000000000000', name: 'X', rule: 'weekly', weekday: 1 })).status).toBe(400);
    expect((await you.ok('POST', '/nicknames', { target_id: meId, name: 'Boss', rule: 'once', on_date: '2026-12-24' })).nickname.on_date).toBe('2026-12-24');
    await me.ok('DELETE', `/nicknames/${rule.id}`);
    expect((await me.ok('GET', '/nicknames')).nicknames).toHaveLength(1);
  });
});
