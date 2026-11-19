import { beforeAll, describe, expect, it } from 'vitest';
import { Client, household, resetDb } from './helpers.js';

beforeAll(resetDb);

describe('Scenario A — private shopping list, partial share', () => {
  it('keeps ME private and shares exactly the selected items as copies', async () => {
    const { me, you } = await household();
    const ids: string[] = [];
    for (let i = 1; i <= 10; i++) {
      const r = await me.ok('POST', '/spaces/me/items', { module: 'grocery', title: `Item ${i}`, quantity: i });
      ids.push(r.item.id);
    }
    // YOU cannot see the private list, by listing or by id
    const theirUs = await you.ok('GET', '/spaces/us/items?module=grocery');
    expect(theirUs.items).toHaveLength(0);
    expect((await you.get(`/items/${ids[0]}`)).status).toBe(404);
    const theirMe = await you.ok('GET', '/spaces/me/items?module=grocery');
    expect(theirMe.items).toHaveLength(0);

    // Preview the whole list, then share six
    const list = (await me.ok('GET', '/spaces/me/lists?module=grocery')).lists[0];
    const preview = await me.ok('POST', '/share/preview', { type: 'item', list_id: list.id });
    expect(preview.entries).toHaveLength(10);
    const chosen = ids.slice(0, 6);
    const shared = await me.ok('POST', '/share', { type: 'item', ids: chosen, edits: { [chosen[0]]: { title: 'Item 1 (edited)' } } });
    expect(shared.created).toHaveLength(6);
    expect(shared.created[0].origin_item_id).toBe(chosen[0]);

    // YOU sees and can interact with the six
    const usItems = (await you.ok('GET', '/spaces/us/items?module=grocery')).items;
    expect(usItems).toHaveLength(6);
    expect(usItems.map((i: any) => i.title)).toContain('Item 1 (edited)');
    expect(usItems.every((i: any) => i.origin_owner_name === 'Nella')).toBe(true);
    const target = usItems.find((i: any) => i.title === 'Item 3');
    await you.ok('PATCH', `/items/${target.id}`, { quantity: 99 });

    // The four excluded remain private; originals untouched (copy, not move)
    const mine = (await me.ok('GET', '/spaces/me/items?module=grocery')).items;
    expect(mine).toHaveLength(10);
    expect(mine.find((i: any) => i.id === chosen[2]).quantity).toBe(3);
    expect(mine.filter((i: any) => i.shared_copy_id)).toHaveLength(6);
    for (const id of ids.slice(6)) expect((await you.get(`/items/${id}`)).status).toBe(404);

    // Re-sharing is prevented as a duplicate
    const again = await me.ok('POST', '/share', { type: 'item', ids: chosen.slice(0, 2) });
    expect(again.created).toHaveLength(0);
    expect(again.skipped.map((s: any) => s.reason)).toEqual(['already_shared', 'already_shared']);

    // Changing the private original never overwrites the shared copy
    await me.ok('PATCH', `/items/${chosen[1]}`, { title: 'Private rename' });
    const copy = (await you.ok('GET', '/spaces/us/items?module=grocery')).items.find((i: any) => i.origin_item_id === chosen[1]);
    expect(copy.title).toBe('Item 2');
    const orig = (await me.ok('GET', `/items/${chosen[1]}`)).item;
    expect(orig.original_changed_since_shared).toBe(true);
  });

  it('moves an item explicitly and can remove an item from US', async () => {
    const { me, you } = await household();
    const a = (await me.ok('POST', '/spaces/me/items', { module: 'idea', title: 'Weekend trip' })).item;
    const b = (await me.ok('POST', '/spaces/me/items', { module: 'idea', title: 'Pottery class' })).item;
    await me.ok('POST', '/share', { type: 'item', ids: [a.id], mode: 'move' });
    expect((await me.ok('GET', '/spaces/me/items?module=idea')).items.map((i: any) => i.id)).toEqual([b.id]);
    expect((await you.ok('GET', `/items/${a.id}`)).item.space).toBe('us');
    await me.ok('POST', '/share', { type: 'item', ids: [b.id] });
    await me.ok('POST', '/share/remove', { type: 'item', id: b.id });
    expect((await you.ok('GET', '/spaces/us/items?module=idea')).items.map((i: any) => i.title)).toEqual(['Weekend trip']);
  });
});

describe('Scenario B — shared item with a discussion thread', () => {
  it('notifies, threads replies and mentions on the jacket', async () => {
    const { me, you, youId } = await household();
    const jacket = (await me.ok('POST', '/spaces/us/items', { module: 'idea', title: 'Jacket for Zsolt', idea_type: 'Clothing', intended_for_user_id: youId, price_cents: 12900, link_url: 'https://shop.example/jacket' })).item;
    let n = (await you.ok('GET', '/notifications')).notifications;
    expect(n.some((x: any) => x.entity_id === jacket.id && x.type === 'shared')).toBe(true);

    const m1 = (await me.ok('POST', `/threads/item/${jacket.id}/messages`, { body: '@Zsolt, do you like this one?' })).message;
    n = (await you.ok('GET', '/notifications?unread=true')).notifications;
    expect(n.some((x: any) => x.type === 'mention' && x.entity_id === jacket.id)).toBe(true);

    const detail = await you.ok('GET', `/items/${jacket.id}`);
    expect(detail.item.title).toBe('Jacket for Zsolt');
    expect(detail.item.thread.unread).toBe(1);
    const reply = (await you.ok('POST', `/threads/item/${jacket.id}/messages`, { body: 'Love it, but in navy?', reply_to_id: m1.id })).message;
    expect(reply.reply_to_id).toBe(m1.id);

    const mine = (await me.ok('GET', '/notifications?unread=true')).notifications;
    expect(mine.some((x: any) => x.type === 'reply' && x.entity_id === jacket.id)).toBe(true);
    await me.ok('POST', `/threads/item/${jacket.id}/messages`, { body: 'Navy it is.' });

    const thread = await you.ok('GET', `/threads/item/${jacket.id}`);
    expect(thread.messages.map((m: any) => m.body)).toEqual(['@Zsolt, do you like this one?', 'Love it, but in navy?', 'Navy it is.']);
    expect(thread.messages[0].mention_ids).toContain(youId);

    // edit/delete own messages only
    expect((await me.patch(`/messages/${reply.id}`, { body: 'hijack' })).status).toBe(403);
    await you.ok('PATCH', `/messages/${reply.id}`, { body: 'Love it — navy please' });
    await you.ok('DELETE', `/messages/${reply.id}`);
    const after = await me.ok('GET', `/threads/item/${jacket.id}`);
    expect(after.messages[1].deleted_at).toBeTruthy();
    expect(after.messages[1].body).toBe('');

    // the discussion moved the decision status forward; reactions work
    await you.ok('POST', `/entities/item/${jacket.id}/reaction`, { reaction: 'love' });
    const final = (await me.ok('GET', `/items/${jacket.id}`)).item;
    expect(final.decision_status).toBe('discussing');
    expect(final.reactions[0]).toMatchObject({ reaction: 'love', name: 'Zsolt' });
  });

  it('does not notify the partner about mentions inside a private item', async () => {
    const { me, you } = await household();
    const secret = (await me.ok('POST', '/spaces/me/items', { module: 'idea', title: 'Surprise gift' })).item;
    await me.ok('POST', `/threads/item/${secret.id}/messages`, { body: '@Zsolt must not know' });
    const n = (await you.ok('GET', '/notifications')).notifications;
    expect(n.some((x: any) => x.entity_id === secret.id)).toBe(false);
    expect((await you.get(`/threads/item/${secret.id}`)).status).toBe(404);
  });
});

describe('Scenario G — task assignment and reminders', () => {
  it('assigns “Book dentist” to YOU with a reminder; YOU completes it; ME sees it', async () => {
    const { me, you, youId } = await household();
    const reminder = new Date(Date.now() - 60_000).toISOString();
    const t = (await me.ok('POST', '/spaces/us/tasks', { title: 'Book dentist', assignee: 'user', assigned_user_id: youId, reminder_at: reminder, priority: 'high' })).task;
    let n = (await you.ok('GET', '/notifications')).notifications;
    expect(n.some((x: any) => x.type === 'assigned' && x.entity_id === t.id)).toBe(true);
    expect(n.some((x: any) => x.type === 'reminder' && x.entity_id === t.id)).toBe(true);
    // reminders are not duplicated
    n = (await you.ok('GET', '/notifications')).notifications;
    expect(n.filter((x: any) => x.type === 'reminder' && x.entity_id === t.id)).toHaveLength(1);

    await you.ok('PATCH', `/tasks/${t.id}`, { status: 'in_progress' });
    await you.ok('PATCH', `/tasks/${t.id}`, { status: 'completed' });
    const seen = (await me.ok('GET', `/tasks/${t.id}`)).task;
    expect(seen.status).toBe('completed');
    expect(seen.completed_by_name).toBe('Zsolt');
    expect(seen.completions).toHaveLength(1);
    const mine = (await me.ok('GET', '/notifications')).notifications;
    expect(mine.some((x: any) => x.entity_id === t.id && /completed/.test(x.title))).toBe(true);
  });

  it('rolls recurring maintenance forward and keeps completion history', async () => {
    const { me } = await household();
    const t = (await me.ok('POST', '/spaces/us/tasks', { title: 'Replace water filter', kind: 'maintenance', due_date: '2026-01-10', recurrence_unit: 'month', recurrence_interval: 3 })).task;
    const done = (await me.ok('PATCH', `/tasks/${t.id}`, { status: 'completed' })).task;
    expect(done.status).toBe('todo');
    expect(done.due_date > '2026-01-10').toBe(true);
    expect((await me.ok('GET', `/tasks/${t.id}`)).task.completions).toHaveLength(1);
  });

  it('rejects assigning a private task to the partner', async () => {
    const { me, youId } = await household();
    expect((await me.post('/spaces/me/tasks', { title: 'x', assignee: 'user', assigned_user_id: youId })).status).toBe(400);
  });

  it('converts a reminder to an event and creates follow-up tasks from events', async () => {
    const { me } = await household();
    const t = (await me.ok('POST', '/spaces/us/tasks', { title: 'Furniture delivery', due_date: '2026-12-02', due_time: '09:30' })).task;
    const ev = (await me.ok('POST', `/tasks/${t.id}/to-event`, { duration_minutes: 120 })).event;
    expect(ev.start_date).toBe('2026-12-02');
    expect(new Date(ev.starts_at).toISOString()).toBe('2026-12-02T08:30:00.000Z'); // Budapest is UTC+1 in December
    const fu = (await me.ok('POST', `/events/${ev.id}/follow-up`, { title: 'Assemble wardrobe' })).task;
    expect(fu.related_event_id).toBe(ev.id);
  });
});

describe('Scenario H — privacy enforcement at the API', () => {
  it('rejects every unauthorized read and write', async () => {
    const h1 = await household();
    const h2 = await household();
    const priv = (await h1.me.ok('POST', '/spaces/me/items', { module: 'home', title: 'Private sofa idea' })).item;
    const shared = (await h1.me.ok('POST', '/spaces/us/items', { module: 'home', title: 'Shared shelving' })).item;
    const privTask = (await h1.me.ok('POST', '/spaces/me/tasks', { title: 'Private task' })).task;
    const privEvent = (await h1.me.ok('POST', '/spaces/me/events', { title: 'Private appt', date: '2026-12-01' })).event;

    // YOU (same household) vs ME's private records
    for (const p of [`/items/${priv.id}`, `/tasks/${privTask.id}`, `/events/${privEvent.id}`, `/threads/item/${priv.id}`, `/entities/item/${priv.id}/activity`]) {
      expect((await h1.you.get(p)).status).toBe(404);
    }
    expect((await h1.you.patch(`/items/${priv.id}`, { title: 'hacked' })).status).toBe(404);
    expect((await h1.you.post(`/entities/item/${priv.id}/archive`)).status).toBe(404);
    expect((await h1.you.post(`/threads/item/${priv.id}/messages`, { body: 'hi' })).status).toBe(404);
    expect((await h1.you.post('/share', { type: 'item', ids: [priv.id] })).status).toBe(404);
    expect((await h1.you.patch(`/tasks/${privTask.id}`, { status: 'completed' })).status).toBe(404);

    // Other household vs this household's shared records
    for (const c of [h2.me, h2.you]) {
      expect((await c.get(`/items/${shared.id}`)).status).toBe(404);
      expect((await c.patch(`/items/${shared.id}`, { title: 'x' })).status).toBe(404);
      expect((await c.post(`/entities/item/${shared.id}/reaction`, { reaction: 'no' })).status).toBe(404);
      expect((await c.ok('GET', '/spaces/us/items?module=home')).items).toHaveLength(0);
    }
    // Unauthenticated
    expect((await new Client().get(`/items/${shared.id}`)).status).toBe(401);
    expect((await new Client().get('/spaces/us/items?module=home')).status).toBe(401);

    // Search never crosses boundaries
    const s1 = (await h1.you.ok('GET', '/search?q=sofa')).results;
    expect(s1).toHaveLength(0);
    const s2 = (await h1.me.ok('GET', '/search?q=sofa')).results;
    expect(s2.map((r: any) => r.id)).toContain(priv.id);
    expect((await h2.me.ok('GET', '/search?q=shelving')).results).toHaveLength(0);

    // Nothing private leaked into the DB-backed record either
    const after = (await h1.me.ok('GET', `/items/${priv.id}`)).item;
    expect(after.title).toBe('Private sofa idea');
  });

  it('protects attachments and categories across spaces', async () => {
    const { me, you } = await household();
    const priv = (await me.ok('POST', '/spaces/me/items', { module: 'home', title: 'Lamp' })).item;
    const fd = new FormData();
    fd.set('entity_type', 'item');
    fd.set('entity_id', priv.id);
    fd.set('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])], 'lamp.png', { type: 'image/png' }));
    const att = (await me.ok('POST', '/attachments', fd)).attachment;
    expect((await me.get(`/attachments/${att.id}`)).status).toBe(200);
    expect((await you.get(`/attachments/${att.id}`)).status).toBe(404);
    // file type is sniffed, not trusted
    const bad = new FormData();
    bad.set('entity_type', 'item');
    bad.set('entity_id', priv.id);
    bad.set('file', new File(['<script>alert(1)</script>'], 'x.png', { type: 'image/png' }));
    expect((await me.post('/attachments', bad)).status).toBe(415);
    // categories from ME cannot be attached to US items
    const myCat = (await me.ok('GET', '/spaces/me/categories?module=home')).categories[0];
    expect((await me.post('/spaces/us/items', { module: 'home', title: 'x', category_id: myCat.id })).status).toBe(400);
  });
});

describe('Archive, restore and confirmed deletion', () => {
  it('archives by default and requires confirmation to delete shared data', async () => {
    const { me, you } = await household();
    const it1 = (await me.ok('POST', '/spaces/us/items', { module: 'home', title: 'Old mirror' })).item;
    expect((await me.del(`/entities/item/${it1.id}`)).status).toBe(400); // must archive first
    await me.ok('POST', `/entities/item/${it1.id}/archive`);
    expect((await you.ok('GET', '/archive')).archived.map((a: any) => a.id)).toContain(it1.id);
    await you.ok('POST', `/entities/item/${it1.id}/unarchive`);
    await me.ok('POST', `/entities/item/${it1.id}/archive`);
    expect((await me.del(`/entities/item/${it1.id}`)).status).toBe(428);
    await me.ok('DELETE', `/entities/item/${it1.id}?confirm=permanent`);
    expect((await me.get(`/items/${it1.id}`)).status).toBe(404);
    const hist = (await me.ok('GET', '/dashboard')).recent;
    expect(hist.some((h: any) => /Permanently deleted/.test(h.summary))).toBe(true);
  });
});
