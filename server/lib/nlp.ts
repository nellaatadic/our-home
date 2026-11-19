import * as chrono from 'chrono-node';
import { addDays, todayIn, tzOffsetMinutes, weekdayOf } from './time.js';

export interface DraftIssue {
  field: 'date' | 'time' | 'title';
  code: 'missing_date' | 'ambiguous_date' | 'ambiguous_time' | 'part_of_day' | 'past_date';
  message: string;
  options?: { label: string; value: string }[];
}

export interface EventDraft {
  source_text: string;
  title: string;
  date: string | null;
  start_time: string | null;
  end_time: string | null;
  duration_minutes: number | null;
  time_hint: string | null;
  location: string;
  participants: string[];
  description: string;
  category: string | null;
  for_person: string | null;   // display name of a household member the event is about
  issues: DraftIssue[];
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const PART_OF_DAY: Record<string, string> = { morning: 'morning', afternoon: 'afternoon', evening: 'evening', tonight: 'evening', night: 'night', noon: 'noon', lunchtime: 'lunchtime' };

const CATEGORY_RULES: [RegExp, string][] = [
  [/\b(dentist|doctor|gp|clinic|hospital|physio|therapy|checkup|check-up|vaccin)/i, 'Health'],
  [/\b(dinner|lunch|brunch|breakfast|drinks|party|birthday|wedding|restaurant|café|cafe|bbq)\b/i, 'Social'],
  [/\b(meeting|call|interview|standup|work|presentation|conference|deadline)\b/i, 'Work'],
  [/\b(oil change|car|service|mot|tyres?|tires?|garage|mechanic)\b/i, 'Car'],
  [/\b(buy|shopping|gifts?|ikea|store|market)\b/i, 'Shopping'],
  [/\b(flight|train|trip|travel|holiday|vacation|hotel)\b/i, 'Travel'],
  [/\b(lecture|exam|class|university|course|seminar)\b/i, 'Study'],
  [/\b(plumber|electrician|repair|delivery|landlord|cleaning|maintenance)\b/i, 'Home'],
];

function pad(n: number) {
  return String(n).padStart(2, '0');
}

/** Split pasted text into candidate event lines (bullets, numbered lists, lines, sentences, semicolons). */
export function splitCandidates(text: string): string[] {
  const out: string[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/^\s*(?:[-*•‣◦·]|\d+[.)]|\[[ x]\])\s*/i, '').trim();
    if (!line) continue;
    for (const part of line.split(/;\s+|(?<=[.!?])\s+(?=[A-Z])/)) {
      const p = part.trim();
      if (p) out.push(p);
    }
  }
  return out;
}

function cleanTitle(s: string) {
  let out = s.replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1');
  for (let i = 0; i < 3; i++) {
    out = out
      .replace(/^[\s,.;:-]+|[\s,.;:!-]+$/g, '')
      .replace(/^(?:on|at|this|next|from|by|for)\s+/i, '')
      .replace(/\s+(?:on|at|this|next|from|by|for|in|the)$/i, '');
  }
  return out.trim();
}

export function parseEventText(text: string, opts: { timezone: string; now?: Date; memberNames?: string[] }): EventDraft[] {
  const now = opts.now ?? new Date();
  const tz = opts.timezone;
  const today = todayIn(tz, now);
  const ref = { instant: now, timezone: tzOffsetMinutes(tz, now) };
  const drafts: EventDraft[] = [];

  for (const candidate of splitCandidates(text)) {
    const results = chrono.parse(candidate, ref, { forwardDate: true });
    const r = results[0];
    if (!r) {
      // A sentence without any date: attach to the previous draft as description, else keep as a draft needing a date.
      if (drafts.length && candidate.length < 300 && !/^[A-Z][a-z]+ (?:on|at)\b/.test(candidate)) {
        const prev = drafts[drafts.length - 1];
        prev.description = [prev.description, candidate].filter(Boolean).join('\n');
        continue;
      }
      drafts.push(baseDraft(candidate, cleanTitle(candidate), [{ field: 'date', code: 'missing_date', message: 'No date found. Choose a date.' }], opts.memberNames));
      continue;
    }
    const issues: DraftIssue[] = [];
    const s = r.start;
    let date: string | null = null;
    const y = s.get('year'), m = s.get('month'), d = s.get('day');
    if (y && m && d) date = `${y}-${pad(m)}-${pad(d)}`;

    // Numeric dates like 4/12 are ambiguous between day/month orders.
    const numeric = r.text.match(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/);
    if (numeric && +numeric[1] <= 12 && +numeric[2] <= 12 && numeric[1] !== numeric[2] && date) {
      const year = date.slice(0, 4);
      const a1 = `${year}-${pad(+numeric[1])}-${pad(+numeric[2])}`;
      const a2 = `${year}-${pad(+numeric[2])}-${pad(+numeric[1])}`;
      issues.push({ field: 'date', code: 'ambiguous_date', message: `“${numeric[0]}” could mean two different dates.`, options: [
        { label: formatDay(a1), value: a1 }, { label: formatDay(a2), value: a2 },
      ] });
      date = null;
    }

    // "next Saturday" — people disagree whether this is the coming one or the one after.
    const nextWd = r.text.match(/\bnext\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
    if (nextWd && date) {
      const wd = WEEKDAYS.indexOf(nextWd[1].toLowerCase());
      let coming = addDays(today, 1);
      while (weekdayOf(coming) !== wd) coming = addDays(coming, 1);
      const following = addDays(coming, 7);
      if (coming !== following) {
        issues.push({ field: 'date', code: 'ambiguous_date', message: `Which ${cap(nextWd[1])} do you mean by “${nextWd[0]}”?`, options: [
          { label: `This coming ${cap(nextWd[1])} (${formatDay(coming)})`, value: coming },
          { label: `The week after (${formatDay(following)})`, value: following },
        ] });
        date = null;
      }
    }

    // A bare weekday that is today ("Thursday" said on a Thursday): today or next week?
    const bareWd = r.text.match(/\b(?:on\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
    if (bareWd && !nextWd && !/\bthis\b/i.test(r.text) && date === today) {
      const nextWeek = addDays(today, 7);
      issues.push({ field: 'date', code: 'ambiguous_date', message: `Today is ${cap(bareWd[1])}. Do you mean today or next week?`, options: [
        { label: `Today (${formatDay(today)})`, value: today }, { label: `Next week (${formatDay(nextWeek)})`, value: nextWeek },
      ] });
      date = null;
    }

    // Time: only when explicitly stated. Never invent one.
    let start_time: string | null = null;
    let time_hint: string | null = null;
    if (s.isCertain('hour')) {
      const h = s.get('hour')!, min = s.get('minute') ?? 0;
      start_time = `${pad(h)}:${pad(min)}`;
      if (!s.isCertain('meridiem') && h >= 1 && h <= 11 && !/\d{1,2}:\d{2}/.test(r.text)) {
        const alt = `${pad(h + 12)}:${pad(min)}`;
        issues.push({ field: 'time', code: 'ambiguous_time', message: `Is ${h} in the morning or the evening?`, options: [
          { label: `${h}:${pad(min)} AM`, value: start_time }, { label: `${h}:${pad(min)} PM`, value: alt },
        ] });
      }
    } else {
      const pod = candidate.toLowerCase().match(/\b(morning|afternoon|evening|tonight|night|noon|lunchtime)\b/);
      if (pod) {
        time_hint = PART_OF_DAY[pod[1]];
        issues.push({ field: 'time', code: 'part_of_day', message: `Only “${pod[1]}” was given — the time is left unspecified.` });
      }
    }

    let end_time: string | null = null;
    if (r.end && r.end.isCertain('hour')) end_time = `${pad(r.end.get('hour')!)}:${pad(r.end.get('minute') ?? 0)}`;
    let duration_minutes: number | null = null;
    const dur = candidate.match(/\bfor\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?)\b/i);
    if (dur) duration_minutes = Math.round(parseFloat(dur[1]) * (/^h/i.test(dur[2]) ? 60 : 1));

    if (date && date < today) issues.push({ field: 'date', code: 'past_date', message: 'This date is in the past.' });
    if (!date && !issues.some((i) => i.field === 'date')) issues.push({ field: 'date', code: 'missing_date', message: 'No full date found. Choose a date.' });

    // Remaining text (without the date phrase) becomes title / location.
    let rest = (candidate.slice(0, r.index) + ' ' + candidate.slice(r.index + r.text.length))
      .replace(/\bfor\s+\d+(?:\.\d+)?\s*(?:hours?|hrs?|h|minutes?|mins?)\b/i, '')
      .replace(/\b(?:this|next)?\s*(?:morning|afternoon|evening|tonight)\b/i, '');
    let location = '';
    const loc = rest.match(/\s(?:at|@)\s+((?:[A-Z0-9ÀÁÂÄÉÈÍÓÖŐÚÜŰ][\p{L}\p{N}'’&.-]*)(?:\s+(?:[A-Z0-9ÀÁÂÄÉÈÍÓÖŐÚÜŰ&][\p{L}\p{N}'’&.-]*|de|la|the|of|on))*)/u);
    if (loc && !/^\d/.test(loc[1])) {
      location = loc[1].trim();
      rest = rest.replace(loc[0], ' ');
    }
    const draft = baseDraft(candidate, cleanTitle(rest) || cleanTitle(candidate), issues, opts.memberNames);
    Object.assign(draft, { date, start_time, end_time, duration_minutes, time_hint, location });
    drafts.push(draft);
  }
  return drafts;
}

function baseDraft(source: string, title: string, issues: DraftIssue[], memberNames: string[] = []): EventDraft {
  const participants: string[] = [];
  const w = source.match(/\bwith\s+((?:[A-ZÀ-Ž][\p{L}'-]+)(?:\s*(?:,|and|&)\s*[A-ZÀ-Ž][\p{L}'-]+)*)/u);
  if (w) for (const n of w[1].split(/\s*(?:,|\band\b|&)\s*/)) if (n.trim()) participants.push(n.trim());
  let for_person: string | null = null;
  for (const name of memberNames) {
    const first = name.split(/\s+/)[0];
    if (new RegExp(`^${escapeRe(first)}\\b|\\b${escapeRe(first)}(?:'s|’s)\\b`, 'i').test(source)) for_person = name;
  }
  const category = CATEGORY_RULES.find(([re]) => re.test(source))?.[1] ?? null;
  if (!title) issues.push({ field: 'title', code: 'missing_date', message: 'Add a title.' });
  return {
    source_text: source, title: title.slice(0, 300), date: null, start_time: null, end_time: null, duration_minutes: null, time_hint: null,
    location: '', participants, description: '', category, for_person, issues,
  };
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
export function formatDay(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
