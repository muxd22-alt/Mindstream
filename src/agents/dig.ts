import type { Ctx, DebateRow } from '../types';
import { createDebate, listPersonas } from '../db/repo';
import { runScout, type ScoutReport } from './scout';
import { executeDebate } from './debate';
import { responseLanguage } from '../util/safety';
import { detectLang } from '../util/text';

export interface DigResult {
  debate: DebateRow;
  scout: ScoutReport;
  query: string;
  requests: number;
}

/** Normalise `/dig #saudi_mortgage_sama` → `saudi mortgage sama`. */
export function digQuery(raw: string, lang: 'ar' | 'en'): string {
  const cleaned = raw
    .replace(/^#+/, '')
    .replace(/[_+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return lang === 'ar' ? 'مواضيع الساعة' : 'current affairs';
  return cleaned.slice(0, 160);
}

export function digQuestion(query: string, lang: 'ar' | 'en'): string {
  return lang === 'ar'
    ? `بناءً على مواقفكم الموثقة، ما الذي يجب أن أعرفه عن "${query}"؟`
    : `Based on your documented views, what should I know about "${query}"?`;
}

/** /dig — Scout searches + stores, then a mini-debate (no Round 2) runs on the fresh sources. */
export async function runDig(
  ctx: Ctx,
  input: { raw: string; chatId: number | null; userId: number | null },
): Promise<DigResult> {
  const lang = responseLanguage(input.raw, ctx.settings) ?? detectLang(input.raw);
  const query = digQuery(input.raw, lang);

  const personas = await listPersonas(ctx, { enabledOnly: true });
  if (!personas.length) throw new Error('No enabled personas.');

  const scout = await runScout(ctx, {
    personaIds: personas.map((p) => p.id),
    query,
    trigger: 'dig',
    maxDocs: 3,
    extractBeliefs: false,
  });

  const debate = await createDebate(ctx, {
    chat_id: input.chatId,
    user_id: input.userId,
    question: digQuestion(query, lang),
    lang,
    mode: 'dig',
    persona_ids: personas.map((p) => p.id),
  });

  const result = await executeDebate(ctx, debate);
  return { debate, scout, query, requests: result.requests };
}
