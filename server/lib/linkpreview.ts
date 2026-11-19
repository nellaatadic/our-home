import { lookup } from 'node:dns/promises';
import net from 'node:net';

/** Reject loopback, private, link-local, CGNAT, multicast and reserved ranges. */
export function isPublicIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb')) return false;
    if (l.startsWith('fc') || l.startsWith('fd') || l.startsWith('ff')) return false;
    const mapped = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    return true;
  }
  return false;
}

export async function assertSafeUrl(raw: string): Promise<URL> {
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) links are supported');
  if (u.username || u.password) throw new Error('Links with credentials are not supported');
  if (u.port && !['80', '443', ''].includes(u.port)) throw new Error('Unusual ports are not supported');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) throw new Error('Private address');
  const addrs = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || !addrs.every((a) => isPublicIp(a.address))) throw new Error('Private address');
  return u;
}

function decodeEntities(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d));
}

export function parseMeta(html: string, base: URL) {
  const metas = new Map<string, string>();
  for (const m of html.matchAll(/<meta\s+[^>]*>/gi)) {
    const tag = m[0];
    const key = (tag.match(/(?:property|name|itemprop)\s*=\s*["']([^"']+)["']/i)?.[1] ?? '').toLowerCase();
    const content = tag.match(/content\s*=\s*["']([^"']*)["']/i)?.[1];
    if (key && content !== undefined && !metas.has(key)) metas.set(key, decodeEntities(content.trim()));
  }
  const title = metas.get('og:title') ?? metas.get('twitter:title') ?? decodeEntities(html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1]?.trim() ?? '');
  let image = metas.get('og:image') ?? metas.get('twitter:image') ?? null;
  if (image) {
    try { image = new URL(image, base).toString(); } catch { image = null; }
    if (image && !/^https?:/i.test(image)) image = null;
  }
  const priceRaw = metas.get('product:price:amount') ?? metas.get('og:price:amount') ?? metas.get('price') ?? null;
  const price = priceRaw && /^\d+([.,]\d{1,2})?$/.test(priceRaw.replace(/\s/g, '')) ? Math.round(parseFloat(priceRaw.replace(',', '.')) * 100) : null;
  const currency = (metas.get('product:price:currency') ?? metas.get('og:price:currency') ?? '').toUpperCase() || null;
  return {
    title: title ? title.slice(0, 200) : null,
    image_url: image ? image.slice(0, 2000) : null,
    site_name: (metas.get('og:site_name') ?? base.hostname).slice(0, 100),
    price_cents: price,
    currency: currency && /^[A-Z]{3}$/.test(currency) ? currency : null,
  };
}

/** Fetch a product/reference page and extract preview metadata. Best-effort, never throws. */
export async function fetchLinkPreview(raw: string) {
  try {
    let url = await assertSafeUrl(raw);
    let res: Response | null = null;
    for (let hop = 0; hop < 4; hop++) {
      res = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(6000),
        headers: { 'user-agent': 'OurHomeLinkPreview/1.0', accept: 'text/html,application/xhtml+xml' },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = await assertSafeUrl(new URL(res.headers.get('location')!, url).toString());
        continue;
      }
      break;
    }
    if (!res || !res.ok || !(res.headers.get('content-type') ?? '').includes('html')) return { ok: false as const, reason: 'No preview available for this link' };
    const reader = res.body!.getReader();
    let html = '';
    const dec = new TextDecoder();
    while (html.length < 600_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
    }
    reader.cancel().catch(() => {});
    return { ok: true as const, ...parseMeta(html, url) };
  } catch (e) {
    return { ok: false as const, reason: (e as Error).message === 'Private address' ? 'That address is not allowed' : 'No preview available for this link' };
  }
}
