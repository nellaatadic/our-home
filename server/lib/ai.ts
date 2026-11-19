import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';

/**
 * Optional AI assistance (natural-language events, receipt reading) through the
 * Claude API. Everything here is best-effort: callers always fall back to the
 * rule-based parser / manual entry, and every result goes through a human
 * review screen before anything is saved.
 */
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5-5';

export function aiConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY) && process.env.AI_FEATURES !== 'off';
}

let client: Anthropic | null = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 1 });
  return client;
}

async function structured<T extends z.ZodType>(schema: T, system: string, content: Anthropic.Beta.BetaContentBlockParam[]): Promise<z.infer<T> | null> {
  // Server-side refusal fallback is enabled ("default" routing); a refusal or
  // unparseable output simply yields null and the caller falls back.
  const res = await getClient().beta.messages.parse({
    model: MODEL,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system,
    messages: [{ role: 'user', content }],
    output_config: { effort: 'low', format: betaZodOutputFormat(schema) },
  });
  if (res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens') return null;
  return (res.parsed_output as z.infer<T>) ?? null;
}

// ------------------------------------------------------------------ events
const AiEvent = z.object({
  source_text: z.string(),
  title: z.string(),
  date: z.string().nullable().describe('YYYY-MM-DD, or null if no date is stated or it is ambiguous'),
  date_ambiguous: z.boolean(),
  date_options: z.array(z.string()).describe('Candidate YYYY-MM-DD dates when ambiguous, else empty'),
  start_time: z.string().nullable().describe('HH:MM 24h, only if explicitly stated'),
  end_time: z.string().nullable(),
  duration_minutes: z.number().nullable(),
  time_hint: z.string().nullable().describe('e.g. "morning" when only a part of day is given'),
  location: z.string(),
  participants: z.array(z.string()),
  description: z.string(),
  category: z.string().nullable(),
  for_person: z.string().nullable().describe('Household member the event is about, if named'),
});
const AiEvents = z.object({ events: z.array(AiEvent) });

export async function extractEventsAI(text: string, ctx: { today: string; weekday: string; timezone: string; members: string[] }) {
  const system = `You turn a household member's pasted text into calendar event drafts for review.
Rules:
- One draft per distinct event; bullet lists and multiple sentences may contain several.
- Resolve relative dates ("Thursday", "next week") against today = ${ctx.today} (${ctx.weekday}), time zone ${ctx.timezone}.
- If a date could reasonably mean more than one day (e.g. "next Saturday", "4/12"), set date to null, date_ambiguous to true and list the candidates.
- Never invent details. If no time is stated, start_time is null. If only "morning"/"evening" is given, start_time is null and time_hint holds the word.
- Household members: ${ctx.members.join(', ') || 'unknown'}.`;
  const out = await structured(AiEvents, system, [{ type: 'text', text: text.slice(0, 8000) }]);
  return out?.events ?? null;
}

// ---------------------------------------------------------------- receipts
const AiReceipt = z.object({
  merchant: z.string().nullable(),
  purchase_date: z.string().nullable().describe('YYYY-MM-DD'),
  currency: z.string().nullable().describe('ISO 4217 code'),
  total: z.number().nullable(),
  tax: z.number().nullable(),
  lines: z.array(z.object({
    raw_text: z.string().describe('The line as printed'),
    name: z.string().describe('Readable product name, e.g. "Whole milk 1L"'),
    quantity: z.number().nullable(),
    unit_price: z.number().nullable(),
    total_price: z.number().nullable(),
    confident: z.boolean().describe('false if the line was hard to read or the product is unclear'),
    category_guess: z.string().nullable(),
  })),
});
export type AiReceiptResult = z.infer<typeof AiReceipt>;

export async function readReceiptAI(file: { data: Uint8Array; type: string }, categories: string[]): Promise<AiReceiptResult | null> {
  const b64 = Buffer.from(file.data).toString('base64');
  const block: Anthropic.Beta.BetaContentBlockParam = file.type === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }
    : { type: 'image', source: { type: 'base64', media_type: file.type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp', data: b64 } };
  const system = `You read shopping receipts. Extract only purchased product lines (not subtotals, payment, loyalty or change lines).
Use numbers as printed (decimal amounts in the receipt currency). Mark confident=false for any line you are not sure about.
Choose category_guess from: ${categories.join(', ')}; or null.`;
  return structured(AiReceipt, system, [block, { type: 'text', text: 'Extract the receipt.' }]);
}
