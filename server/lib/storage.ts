import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Private file storage. Production uses Netlify Blobs (site-scoped, never
 * publicly addressable — files are only served through the authorized
 * /api/attachments/:id route). Local development and tests use the filesystem.
 */
export interface BlobStorage {
  put(key: string, data: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

class FsStorage implements BlobStorage {
  constructor(private root: string) {}
  private p(key: string) {
    if (!/^[a-z0-9/_-]+$/i.test(key) || key.includes('..')) throw new Error('bad key');
    return path.join(this.root, key);
  }
  async put(key: string, data: Uint8Array) {
    const file = this.p(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }
  async get(key: string) {
    try { return new Uint8Array(await readFile(this.p(key))); } catch { return null; }
  }
  async delete(key: string) {
    await unlink(this.p(key)).catch(() => {});
  }
}

class NetlifyBlobStorage implements BlobStorage {
  private storePromise = import('@netlify/blobs').then((m) => m.getStore({ name: 'attachments', consistency: 'strong' }));
  async put(key: string, data: Uint8Array, contentType: string) {
    const store = await this.storePromise;
    const copy = new Uint8Array(data);
    await store.set(key, copy.buffer, { metadata: { contentType } });
  }
  async get(key: string) {
    const store = await this.storePromise;
    const buf = await store.get(key, { type: 'arrayBuffer' });
    return buf ? new Uint8Array(buf) : null;
  }
  async delete(key: string) {
    const store = await this.storePromise;
    await store.delete(key);
  }
}

let storage: BlobStorage | null = null;

export function getStorage(): BlobStorage {
  if (storage) return storage;
  const driver = process.env.STORAGE_DRIVER ?? (process.env.NETLIFY || process.env.NETLIFY_BLOBS_CONTEXT || process.env.AWS_LAMBDA_FUNCTION_NAME ? 'netlify' : 'fs');
  storage = driver === 'netlify' ? new NetlifyBlobStorage() : new FsStorage(process.env.STORAGE_DIR ?? path.resolve('.data/blobs'));
  return storage;
}

export function setStorage(s: BlobStorage | null) {
  storage = s;
}

// ---- upload validation (magic bytes, not the client-supplied type)
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024; // Netlify Functions accept ~6 MB request bodies

export function sniffContentType(b: Uint8Array): string | null {
  const s = (o: number, sig: number[]) => sig.every((v, i) => b[o + i] === v);
  if (s(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (s(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (s(0, [0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (s(0, [0x52, 0x49, 0x46, 0x46]) && s(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
  if (s(0, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  if (s(4, [0x66, 0x74, 0x79, 0x70]) && ['heic', 'heix', 'mif1', 'msf1'].includes(String.fromCharCode(...b.slice(8, 12)))) return 'image/heic';
  return null;
}

export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  return base.replace(/[^\w.\- ()]/g, '_').slice(0, 120) || 'file';
}
