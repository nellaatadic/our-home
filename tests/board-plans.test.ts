import { beforeAll, describe, expect, it } from 'vitest';
import { household, resetDb } from './helpers.js';

beforeAll(resetDb);

const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], 'p.png', { type: 'image/png' });
const ref = (title: string, type: string, id: string) => `@[${title}](${type}:${id})`;

describe('Custom lists', () => {
  it('makes, fills, archives, restores and deletes a list of our own', async () => {
    const { me, you } = await household();
    const books = (await me.ok('POST', '/lists', { name: 'Books to read', emoji: '📚', sections: ['Fiction', 'Non-fiction'] })).list;
    expect(books.private).toBe(false);
    const nav = await you.ok('GET', '/lists/nav');
    expect(nav.custom.map((l: any) => l.name)).toContain('Books to read');
    expect(Object.keys(nav.builtin).sort()).toEqual(['grocery', 'home', 'idea']);

    const sections = (await me.ok('GET', `/lists/${books.id}/sections`)).categories;
    const fiction = sections.find((s: any) => s.name === 'Fiction');
    const item = (await me.ok('POST', '/modules/custom/items', { title: 'Piranesi', list_id: books.id, category_id: fiction.id })).item;
    expect(item.module).toBe('custom');
    expect(item.category.name).toBe('Fiction');
    // A section from a different list is refused.
    const other = (await me.ok('POST', '/lists', { name: 'Films' })).list;
    const otherSection = (await me.ok('POST', `/lists/${other.id}/sections`, { name: 'Drama' })).category;
    expect((await me.post('/modules/custom/items', { title: 'X', list_id: books.id, category_id: otherSection.id })).status).toBe(400);

    const listed = await you.ok('GET', `/modules/custom/items?list=${books.id}`);
    expect(listed.items.map((i: any) => i.title)).toEqual(['Piranesi']);
    expect(listed.counts.need).toBe(1);
    expect((await you.ok('GET', `/modules/custom/items?list=${other.id}`)).items).toHaveLength(0);

    // Shows on the dashboard as its own widget.
    const dash = await me.ok('GET', '/dashboard');
    expect(dash.lists[books.id].need).toBe(1);
    await me.ok('PATCH', '/household/settings', { dashboard: { widgets: { ...dash.prefs.widgets, [books.id]: { max: 3, size: 'm' } } } });
    expect((await me.ok('GET', '/dashboard')).prefs.widgets[books.id].size).toBe('m');

    // Move an item from Groceries into the custom list, sections matched by name.
    const g = (await me.ok('POST', '/modules/grocery/items', { title: 'Cookbook' })).item;
    const moved = (await me.ok('PATCH', `/items/${g.id}`, { module: 'custom', list_id: books.id })).item;
    expect(moved.module).toBe('custom');
    expect(moved.list_id).toBe(books.id);

    // Archive → items go with it; restore → they come back.
    await me.ok('PATCH', `/lists/${books.id}`, { archived: true });
    expect((await you.ok('GET', '/lists/nav')).custom.map((l: any) => l.name)).not.toContain('Books to read');
    expect((await you.get(`/items/${item.id}`)).data.item.archived_at).not.toBeNull();
    const archive = (await you.ok('GET', '/archive')).archived;
    expect(archive.some((a: any) => a.type === 'list' && a.id === books.id)).toBe(true);
    expect(archive.some((a: any) => a.type === 'item' && a.id === item.id)).toBe(false);
    await me.ok('PATCH', `/lists/${books.id}`, { archived: false });
    expect((await you.get(`/items/${item.id}`)).data.item.archived_at).toBeNull();

    // Permanent deletion needs archiving and confirmation.
    expect((await me.del(`/lists/${books.id}`)).status).toBe(400);
    await me.ok('PATCH', `/lists/${books.id}`, { archived: true });
    expect((await me.del(`/lists/${books.id}`)).status).toBe(428);
    await me.ok('DELETE', `/lists/${books.id}?confirm=permanent`);
    expect((await me.get(`/items/${item.id}`)).status).toBe(404);
  });

  it('keeps everything in a private list private', async () => {
    const { me, you } = await household();
    const gifts = (await me.ok('POST', '/lists', { name: 'Gift ideas for Zsolt', private: true })).list;
    expect(gifts.private).toBe(true);
    const watch = (await me.ok('POST', '/modules/custom/items', { title: 'Watch', list_id: gifts.id })).item;
    expect(watch.private).toBe(true);
    expect((await you.ok('GET', '/lists/nav')).custom).toHaveLength(0);
    expect((await you.get(`/modules/custom/items?list=${gifts.id}`)).status).toBe(400);
    expect((await you.get(`/items/${watch.id}`)).status).toBe(404);
    // It cannot be unlocked out of a private list.
    expect((await me.post(`/items/${watch.id}/privacy`, { private: false })).status).toBe(400);
    // A shared item can't be moved into the private list without locking it first.
    const shared = (await me.ok('POST', '/modules/idea/items', { title: 'Scarf' })).item;
    expect((await me.patch(`/items/${shared.id}`, { module: 'custom', list_id: gifts.id })).status).toBe(400);
  });

  it('lets a locked item stay in a shared list, hidden from the partner', async () => {
    const { me, you } = await household();
    const party = (await me.ok('POST', '/lists', { name: 'Party' })).list;
    const surprise = (await me.ok('POST', '/modules/custom/items', { title: 'Surprise cake', list_id: party.id, private: true })).item;
    expect(surprise.private).toBe(true);
    expect(surprise.list_id).toBe(party.id);
    expect((await you.ok('GET', `/modules/custom/items?list=${party.id}`)).items).toHaveLength(0);
    const unlocked = (await me.ok('POST', `/items/${surprise.id}/privacy`, { private: false })).item;
    expect(unlocked.list_id).toBe(party.id);
    expect((await you.ok('GET', `/modules/custom/items?list=${party.id}`)).items).toHaveLength(1);
  });
});

describe('Board', () => {
  it('pins notes with running names, moves them and keeps locked ones private', async () => {
    const { me, you } = await household();
    const a = (await me.ok('POST', '/pins', { body: 'Call the plumber' })).pin;
    const b = (await you.ok('POST', '/pins', { kind: 'note', color: 'sage' })).pin;
    expect(a.title).toBe('New sticky 1');
    expect(b.title).toBe('New sticky 2');
    const named = (await me.ok('POST', '/pins', { kind: 'text', title: 'Summer!', body: 'Lake trip in July' })).pin;
    expect(named.title).toBe('Summer!');

    const moved = (await you.ok('PATCH', `/pins/${a.id}`, { x: 1100, y: 300, w: 300 })).pin;
    expect(moved.x).toBe(900); // clamped to the wall width (1200 − 300)
    expect(moved.y).toBe(300);
    expect((await you.patch(`/pins/${a.id}`, { w: 50 })).status).toBe(400);

    const fd = new FormData();
    fd.set('entity_type', 'pin'); fd.set('entity_id', named.id); fd.set('file', png());
    await me.ok('POST', '/attachments', fd);
    expect((await you.ok('GET', `/pins/${named.id}`)).pin.images).toHaveLength(1);

    expect((await you.post(`/pins/${named.id}/privacy`, { private: true })).status).toBe(403);
    await me.ok('POST', `/pins/${named.id}/privacy`, { private: true });
    expect((await you.ok('GET', '/board')).pins.map((p: any) => p.id)).not.toContain(named.id);
    expect((await you.get(`/pins/${named.id}`)).status).toBe(404);
    expect((await me.ok('GET', '/board')).pins.map((p: any) => p.id)).toContain(named.id);

    // Pins can be referenced in chat, and archived.
    const refs = (await you.ok('GET', '/chat/references?q=sticky')).references;
    expect(refs.some((r: any) => r.type === 'pin' && r.id === a.id)).toBe(true);
    await me.ok('POST', `/entities/pin/${a.id}/archive`);
    expect((await you.ok('GET', '/board')).pins.map((p: any) => p.id)).not.toContain(a.id);
    expect((await you.ok('GET', '/archive')).archived.some((x: any) => x.type === 'pin' && x.id === a.id)).toBe(true);
  });
});

describe('Plans', () => {
  it('gives a plan a checklist, lists, linked things and an archive prompt', async () => {
    const { me, you, youId } = await household();
    const plan = (await me.ok('POST', '/spaces/us/events', { title: 'Dinner with Marco', date: '2026-11-01', start_time: '19:00', is_plan: true, tags: ['marco'] })).event;
    expect(plan.is_plan).toBe(true);
    // Any event can open as a plan; adding a to-do to it makes it one.
    const plain = (await me.ok('POST', '/spaces/us/events', { title: 'Dentist', date: '2026-12-01' })).event;
    expect((await me.ok('GET', `/plans/${plain.id}`)).plan.is_plan).toBe(false);
    await me.ok('POST', '/spaces/us/tasks', { title: 'Find the insurance card', related_event_id: plain.id });
    expect((await me.ok('GET', `/plans/${plain.id}`)).plan.is_plan).toBe(true);

    await me.ok('POST', '/spaces/us/tasks', { title: 'Make a reservation', related_event_id: plan.id, assignee: 'user', assigned_user_id: youId });
    const list = (await me.ok('POST', '/lists', { name: 'Bring along', event_id: plan.id })).list;
    await you.ok('POST', '/modules/custom/items', { title: 'Wine', list_id: list.id });
    // Plan lists are not in the sidebar.
    expect((await me.ok('GET', '/lists/nav')).custom.map((l: any) => l.id)).not.toContain(list.id);

    const pin = (await me.ok('POST', '/pins', { title: 'Restaurant ideas', tags: ['Marco'] })).pin;
    await you.ok('POST', `/threads/event/${plan.id}/messages`, { body: `Look at ${ref('Restaurant ideas', 'pin', pin.id)}` });

    const page = await you.ok('GET', `/plans/${plan.id}`);
    expect(page.checklist.map((t: any) => t.title)).toEqual(['Make a reservation']);
    expect(page.lists[0].items.map((i: any) => i.title)).toEqual(['Wine']);
    // The date (1 Nov 2026) has passed, so the page asks whether to archive.
    expect(page.plan.over).toBe(true);
    expect(page.plan.ask_to_archive).toBe(true);

    const links = await you.ok('GET', `/links/event/${plan.id}`);
    expect(links.mentions.map((c: any) => c.title)).toEqual(['Restaurant ideas']);
    expect(links.tagged.map((c: any) => c.title)).toContain('Restaurant ideas');
    const back = await me.ok('GET', `/links/pin/${pin.id}`);
    expect(back.mentioned_in.map((c: any) => c.title)).toEqual(['Dinner with Marco']);

    const dash = await me.ok('GET', '/dashboard');
    const onDash = dash.plans.find((p: any) => p.id === plan.id);
    expect(onDash.checklist).toEqual({ total: 1, done: 0 });
    expect(onDash.ask_to_archive).toBe(true);

    await me.ok('POST', `/plans/${plan.id}/keep`);
    expect((await me.ok('GET', `/plans/${plan.id}`)).plan.ask_to_archive).toBe(false);

    // Archiving the plan archives its checklist and lists; restoring brings them back.
    await me.ok('POST', `/entities/event/${plan.id}/archive`);
    expect((await me.ok('GET', '/dashboard')).todos.map((t: any) => t.title)).not.toContain('Make a reservation');
    const archive = (await me.ok('GET', '/archive')).archived;
    expect(archive.filter((x: any) => x.id === plan.id).map((x: any) => x.type)).toEqual(['plan']);
    expect(archive.some((x: any) => x.title === 'Make a reservation')).toBe(false);
    await me.ok('POST', `/entities/event/${plan.id}/unarchive`);
    const restored = await me.ok('GET', `/plans/${plan.id}`);
    expect(restored.checklist).toHaveLength(1);
    expect(restored.lists[0].items).toHaveLength(1);
  });
});

describe('Main chat → cards', () => {
  it('copies a tagged message and its replies into the card, and follows edits', async () => {
    const { me, you } = await household();
    const general = (await me.ok('GET', '/chat/general')).topic;
    const plan = (await me.ok('POST', '/spaces/us/events', { title: 'Marco dinner', date: '2026-12-20', is_plan: true })).event;
    const tag = (await me.ok('POST', `/threads/topic/${general.id}/messages`, { body: `Shall we book ${ref('Marco dinner', 'event', plan.id)} for 7?` })).message;
    // Nothing is copied until someone replies.
    expect((await me.ok('GET', `/threads/event/${plan.id}`)).messages).toHaveLength(0);

    const reply = (await you.ok('POST', `/threads/topic/${general.id}/messages`, { body: 'Yes, 7 works', reply_to_id: tag.id })).message;
    const copied = (await me.ok('GET', `/threads/event/${plan.id}`)).messages;
    expect(copied.map((m: any) => m.body)).toEqual([tag.body, 'Yes, 7 works']);
    expect(copied.every((m: any) => m.mirrored_from_id)).toBe(true);
    expect(copied[1].reply_to_id).toBe(copied[0].id);
    expect(copied[1].author_name).toBe('Zsolt');

    // A reply to the reply is copied too; nothing is duplicated.
    await me.ok('POST', `/threads/topic/${general.id}/messages`, { body: 'Booked!', reply_to_id: reply.id });
    expect((await me.ok('GET', `/threads/event/${plan.id}`)).messages.map((m: any) => m.body)).toEqual([tag.body, 'Yes, 7 works', 'Booked!']);

    // Copies are not counted as unread a second time.
    const unread = (await you.ok('GET', '/chat/unread')).unread;
    expect(unread).toBe(1); // only “Booked!” in Our chat, not its copy on the card

    // Edits and deletions follow the original; copies cannot be edited directly.
    await you.ok('PATCH', `/messages/${reply.id}`, { body: 'Yes, 7:30 works' });
    const after = (await me.ok('GET', `/threads/event/${plan.id}`)).messages;
    expect(after[1].body).toBe('Yes, 7:30 works');
    expect((await you.patch(`/messages/${after[1].id}`, { body: 'x' })).status).toBe(403);
    await you.ok('DELETE', `/messages/${reply.id}`);
    expect((await me.ok('GET', `/threads/event/${plan.id}`)).messages[1].deleted_at).not.toBeNull();

    // The card's links show it was discussed in the main chat.
    expect((await me.ok('GET', `/links/event/${plan.id}`)).in_main_chat).toBeGreaterThan(0);
  });

  it('does not copy into a card the replying person cannot open', async () => {
    const { me, you } = await household();
    const general = (await me.ok('GET', '/chat/general')).topic;
    const secret = (await me.ok('POST', '/modules/idea/items', { title: 'Surprise trip', private: true })).item;
    const tag = (await me.ok('POST', `/threads/topic/${general.id}/messages`, { body: `Thinking about ${ref('Surprise trip', 'item', secret.id)}` })).message;
    await you.ok('POST', `/threads/topic/${general.id}/messages`, { body: 'What is that?', reply_to_id: tag.id });
    expect((await me.ok('GET', `/threads/item/${secret.id}`)).messages).toHaveLength(0);
  });
});

describe('List chats', () => {
  it('has one conversation per list, shared or private like the list', async () => {
    const { me, you } = await household();
    const nav = await me.ok('GET', '/lists/nav');
    const groceries = nav.builtin.grocery;
    await me.ok('POST', `/threads/list/${groceries}/messages`, { body: 'Big shop on Saturday?' });
    expect((await you.ok('GET', `/threads/list/${groceries}`)).messages.map((m: any) => m.body)).toEqual(['Big shop on Saturday?']);
    const cards = (await you.ok('GET', '/chat/cards')).cards;
    expect(cards.find((c: any) => c.entity_type === 'list' && c.entity_id === groceries).title).toBe('Groceries');
    expect((await you.ok('GET', '/notifications')).notifications.length).toBeGreaterThan(0);

    const secret = (await me.ok('POST', '/lists', { name: 'Gift ideas', private: true })).list;
    await me.ok('POST', `/threads/list/${secret.id}/messages`, { body: 'Something for his birthday' });
    expect((await you.get(`/threads/list/${secret.id}`)).status).toBe(404);
    // Lists are archived through /lists only.
    expect((await me.post(`/entities/list/${groceries}/archive`)).status).toBe(404);
  });
});
