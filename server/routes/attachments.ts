import { Hono } from 'hono';
import { q, q1 } from '../db.js';
import { requireAuth } from '../lib/auth.js';
import { canAccessWorkspace, loadEntity, workspaceFor, type AppEnv } from '../lib/access.js';
import { badRequest, HttpError, notFound, parse, space, uuid } from '../lib/http.js';
import { getStorage, MAX_UPLOAD_BYTES, safeFilename, sniffContentType } from '../lib/storage.js';
import { logActivity } from '../lib/notify.js';

export const attachmentRoutes = new Hono<AppEnv>();
export const PENDING_ID = '00000000-0000-0000-0000-000000000000';
const OWNER_TYPES = ['item', 'task', 'event', 'inventory', 'expense'] as const;

export async function readUpload(file: unknown) {
  if (!(file instanceof File)) throw badRequest('Choose a file to upload');
  if (file.size === 0) throw badRequest('The file is empty');
  if (file.size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'too_large', 'Files can be at most 4 MB. Photos are resized automatically in the app.');
  const data = new Uint8Array(await file.arrayBuffer());
  const type = sniffContentType(data);
  if (!type) throw new HttpError(415, 'unsupported_type', 'Only JPEG, PNG, WebP, GIF, HEIC images and PDF files are supported');
  return { data, type, filename: safeFilename(file.name) };
}

export async function storeAttachment(workspaceId: string, entityType: string, entityId: string, userId: string, up: { data: Uint8Array; type: string; filename: string }) {
  const key = `ws/${workspaceId}/${crypto.randomUUID()}`;
  await getStorage().put(key, up.data, up.type);
  return q1<any>(
    `INSERT INTO attachments (workspace_id, entity_type, entity_id, blob_key, filename, content_type, size_bytes, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, filename, content_type, size_bytes, created_at`,
    [workspaceId, entityType, entityId, key, up.filename, up.type, up.data.length, userId],
  );
}

/**
 * multipart/form-data: file, entity_type, entity_id
 * For a message attachment that is uploaded before the message exists:
 * entity_type=message, space=me|us (stored as pending until the message is sent).
 */
attachmentRoutes.post('/attachments', async (c) => {
  const a = requireAuth(c);
  const form = await c.req.formData();
  const entityType = String(form.get('entity_type') ?? '');
  let workspaceId: string;
  let entityId: string;
  if (entityType === 'message') {
    workspaceId = workspaceFor(a, parse(space, form.get('space')));
    entityId = PENDING_ID;
  } else if ((OWNER_TYPES as readonly string[]).includes(entityType)) {
    const ent = await loadEntity<any>(a, entityType as (typeof OWNER_TYPES)[number], parse(uuid, form.get('entity_id')));
    workspaceId = ent.workspace_id;
    entityId = ent.id;
  } else throw badRequest('Unknown attachment target');
  const up = await readUpload(form.get('file'));
  const att = await storeAttachment(workspaceId, entityType, entityId, a.user.id, up);
  if (entityType !== 'message') await logActivity(workspaceId, entityType, entityId, a.user.id, 'attached', `Attached ${up.filename}`);
  return c.json({ attachment: { ...att, url: `/api/attachments/${att.id}` } }, 201);
});

attachmentRoutes.get('/attachments/:id', async (c) => {
  const a = requireAuth(c);
  const att = await q1<any>('SELECT * FROM attachments WHERE id = $1', [parse(uuid, c.req.param('id'))]);
  if (!att || !canAccessWorkspace(a, att.workspace_id)) throw notFound();
  const data = await getStorage().get(att.blob_key);
  if (!data) throw notFound('File is missing from storage');
  const inline = att.content_type.startsWith('image/') || att.content_type === 'application/pdf';
  return new Response(new Uint8Array(data), {
    headers: {
      'content-type': att.content_type,
      'content-length': String(data.length),
      'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${att.filename.replace(/"/g, '')}"`,
      'cache-control': 'private, max-age=3600',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
});

attachmentRoutes.delete('/attachments/:id', async (c) => {
  const a = requireAuth(c);
  const att = await q1<any>('SELECT * FROM attachments WHERE id = $1', [parse(uuid, c.req.param('id'))]);
  if (!att || !canAccessWorkspace(a, att.workspace_id)) throw notFound();
  await getStorage().delete(att.blob_key);
  await q('DELETE FROM attachments WHERE id = $1', [att.id]);
  return c.json({ ok: true });
});
