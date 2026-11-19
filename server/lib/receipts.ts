/** Receipt text parsing and product matching (no external services). */

export interface ParsedLine {
  raw_text: string;
  name: string;
  quantity: number | null;
  unit_price_cents: number | null;
  total_cents: number | null;
  needs_review: boolean;
  review_reason: string | null;
  category_guess?: string | null;
}

export interface ParsedReceipt {
  merchant: string | null;
  purchase_date: string | null;
  total_cents: number | null;
  tax_cents: number | null;
  lines: ParsedLine[];
}

const SKIP = /\b(sub\s*total|subtotal|total|tax|vat|mwst|áfa|change|cash|card|visa|mastercard|amex|balance|payment|paid|tender|thank|receipt|tel|phone|www\.|vat\s*no|iban|approval|auth|loyalty|points|savings|discount total|rounding)\b/i;
const PRICE = /(-?\d{1,6}[.,]\d{2})\s*[A-Z*]?\s*$/;

function cents(s: string) {
  return Math.round(parseFloat(s.replace(',', '.')) * 100);
}

export function parseReceiptText(text: string): ParsedReceipt {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let merchant: string | null = null;
  let purchase_date: string | null = null;
  let total_cents: number | null = null;
  let tax_cents: number | null = null;
  const out: ParsedLine[] = [];

  for (const raw of lines) {
    const iso = raw.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/);
    const eu = raw.match(/\b(\d{1,2})[/.](\d{1,2})[/.](20\d{2}|\d{2})\b/);
    if (!purchase_date && iso) purchase_date = `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
    else if (!purchase_date && eu) {
      const y = eu[3].length === 2 ? `20${eu[3]}` : eu[3];
      purchase_date = `${y}-${eu[2].padStart(2, '0')}-${eu[1].padStart(2, '0')}`; // day-first (most receipts outside the US)
    }
    const price = raw.match(PRICE);
    if (/\btotal\b/i.test(raw) && !/sub/i.test(raw) && price) { total_cents = cents(price[1]); continue; }
    if (/\b(tax|vat|áfa|mwst)\b/i.test(raw) && price) { tax_cents = cents(price[1]); continue; }
    if (!price) {
      if (!merchant && out.length === 0 && /[a-z]{3,}/i.test(raw) && !iso && !eu) merchant = raw.slice(0, 120);
      continue;
    }
    if (SKIP.test(raw)) continue;
    let body = raw.slice(0, price.index).trim();
    const total = cents(price[1]);
    if (total <= 0) continue; // discounts / voids are not products
    let quantity: number | null = null;
    let unit: number | null = null;
    let m = body.match(/^(\d+(?:[.,]\d+)?)\s*[xX*×]\s*(.+)$/);
    if (m) { quantity = parseFloat(m[1].replace(',', '.')); body = m[2]; }
    m = body.match(/^(.+?)\s+(\d+(?:[.,]\d+)?)\s*(?:kg|pcs|pc|st)?\s*[xX*×@]\s*(\d+[.,]\d{2})$/i);
    if (m) { body = m[1]; quantity = parseFloat(m[2].replace(',', '.')); unit = cents(m[3]); }
    const name = body.replace(/\s{2,}/g, ' ').replace(/[#*]+/g, '').trim();
    const letters = (name.match(/\p{L}/gu) ?? []).length;
    const needs_review = letters < 3 || /^\d+$/.test(name);
    out.push({
      raw_text: raw, name: prettify(name), quantity, unit_price_cents: unit ?? (quantity ? Math.round(total / quantity) : total), total_cents: total,
      needs_review, review_reason: needs_review ? 'Could not read the product name' : null,
    });
  }
  return { merchant, purchase_date, total_cents, tax_cents, lines: out };
}

/** "WHL MILK 1L" → "Whl Milk 1L": receipts are usually uppercase. */
function prettify(s: string) {
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase()).replace(/\b(\d+)(Kg|G|L|Ml|Cl)\b/g, (_, n, u) => n + u.toLowerCase());
}

const STOP = new Set(['the', 'and', 'with', 'pack', 'bio', 'organic', 'fresh', 'large', 'small', 'kg', 'pcs', 'ml', 'cl', 'ltr', 'x']);
export function tokens(s: string): string[] {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+[a-z]*$/.test(t)).map((t) => (t.endsWith('es') ? t.slice(0, -2) : t.endsWith('s') ? t.slice(0, -1) : t));
}

/** Score how likely a receipt line refers to a known item (0..1). */
export function matchScore(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const hits = tb.filter((t) => ta.some((x) => x === t || (x.length >= 4 && t.length >= 4 && (x.startsWith(t) || t.startsWith(x)))));
  return hits.length / tb.length;
}

export function bestMatch<T extends { id: string; title: string }>(name: string, candidates: T[], threshold = 0.6): T | null {
  let best: T | null = null, bestScore = 0;
  for (const c of candidates) {
    const s = matchScore(name, c.title);
    if (s > bestScore) { best = c; bestScore = s; }
  }
  return bestScore >= threshold ? best : null;
}
