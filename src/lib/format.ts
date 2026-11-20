export function money(cents: number | null | undefined, currency = 'CAD') {
  if (cents == null) return '';
  try {
    return new Intl.NumberFormat('en-CA', { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export function parseMoney(input: string): number | null {
  const t = input.trim().replace(/\s/g, '').replace(/[^\d.,-]/g, '');
  if (!t) return null;
  const normalized = t.includes(',') && !t.includes('.') ? t.replace(',', '.') : t.replace(/,/g, '');
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

export function day(date: string | null | undefined, opts: Intl.DateTimeFormatOptions = { weekday: 'short', day: 'numeric', month: 'short' }) {
  if (!date) return '';
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
}

export function relative(ts: string | null | undefined) {
  if (!ts) return '';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function todayLocal(tz: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function addDays(date: string, n: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function eventTime(e: { all_day: boolean; time_unspecified: boolean; start_time: string | null; end_time: string | null }) {
  if (e.all_day) return 'All day';
  if (e.time_unspecified || !e.start_time) return 'Time not set';
  return e.end_time ? `${time12(e.start_time)} – ${time12(e.end_time)}` : time12(e.start_time);
}

export function qty(n: number | null | undefined, unit?: string | null) {
  if (n == null) return '';
  const s = Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
  return unit ? `${s} ${unit}` : `×${s}`;
}

/** "14:00" → "2:00 PM" (12-hour, as used in Canada). */
export function time12(t: string | null | undefined) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Today", "Tomorrow", "Yesterday" or a short date, plus the time if set. */
export function dueLabel(date: string | null | undefined, time: string | null | undefined, today: string) {
  if (!date) return '';
  const d = date === today ? 'Today' : date === addDays(today, 1) ? 'Tomorrow' : date === addDays(today, -1) ? 'Yesterday' : day(date, { weekday: 'short', month: 'short', day: 'numeric' });
  return time ? `${d}, ${time12(time.slice(0, 5))}` : d;
}

export function greeting(tz: string) {
  const h = Number(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}
