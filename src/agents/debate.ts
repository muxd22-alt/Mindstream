import type {
  Answer,
  Citation,
  Ctx,
  DebateRow,
  DebateState,
  MessageRow,
  PersonaRow,
  Round1Item,
  Round2Item,
  ScribeResult,
} from '../types';
import { addMessage, getDebate, getPersonas, listMessages, recordHashtags, updateDebate } from '../db/repo';
import { llm } from '../llm/openrouter';
import { asArray, extractJson, oneOf, str } from '../llm/json';
import { renderPrompt, splitSystemUser } from '../prompts';
import { personaBlock, retrieveForPersona, sourcesBlock, type PersonaBlock } from '../rag/retrieve';
import { sendDocument, sendMessage } from '../telegram/api';
import { renderPersonaAnswer, renderPersonaReply, renderScribe } from '../telegram/format';
import { cleanHashtag, limitWords, uniqueBy } from '../util/text';
import { defaultFooter, isSensitiveQuestion, safetyLine } from '../util/safety';
import { buildNotebookPack } from './notebook';

const STAGES = ['round1', 'round2', 'scribe', 'pack', 'done'] as const;
type Stage = (typeof STAGES)[number];

export interface ExecuteResult {
  model: string | null;
  requests: number;
  stage: Stage;
}

type Refs = Record<string, Record<string, Citation>>;

// ---------------------------------------------------------------- main flow

/**
 * Advances a debate through every remaining stage.
 *
 * Round 1 runs as one call per persona **in parallel** (default), and each answer
 * is posted to Telegram the moment it finishes — that is what makes it feel live.
 * Every stage is checkpointed, and already-posted round-1 messages are skipped on
 * retry, so a crash never double-posts or double-pays.
 */
export async function executeDebate(ctx: Ctx, debate: DebateRow): Promise<ExecuteResult> {
  let d = debate;
  let model: string | null = d.model;
  let requests = 0;

  const personas = (await getPersonas(ctx, d.persona_ids)).filter((p) => p.enabled);
  if (!personas.length) throw new Error('No enabled personas in this debate.');
  const lang = d.lang;

  // ---------------- Round 1
  if (stageIndex(d.stage) <= stageIndex('round1')) {
    if (!d.state.round1) {
      const { blocks, refsByPersona } = await ensureBlocks(ctx, d, personas);
      d.state.blocks = blocks;

      const prior = await listMessages(ctx, d.id);
      const priorRound1 = prior.filter((m) => m.round === 1 && m.role === 'persona');

      if (ctx.settings.parallel_round1) {
        const collected: Round1Item[] = [];
        let lastModel: string | null = null;
        const settled = await Promise.allSettled(
          personas.map(async (persona) => {
            const already = priorRound1.find((m) => m.persona_id === persona.id);
            if (already) return { item: itemFromMessage(already), model: null as string | null };

            const res = await llm(ctx, {
              messages: buildSingleMessages(ctx, d, persona, blocks[persona.id], lang),
              modelOverride: persona.model_override,
              label: `round1:${persona.id}`,
              temperature: 0.85,
              maxTokens: 900,
            });
            requests++;
            const item = parseRound1(res.text, [persona], { [persona.id]: refsByPersona[persona.id] ?? {} }, ctx.settings.persona_word_limit, lang)[0];

            await addMessage(ctx, {
              debate_id: d.id,
              persona_id: persona.id,
              round: 1,
              role: 'persona',
              answer: item.answer,
              body: item.reasoning,
              citations: item.citations,
              inference: item.inference,
              model: res.model,
            });
            await updateDebate(ctx, d.id, { model: res.model });
            await safeSend(ctx, d.chat_id, renderPersonaAnswer(persona, item, lang));
            return { item, model: res.model };
          }),
        );

        for (const outcome of settled) {
          if (outcome.status === 'fulfilled') {
            collected.push(outcome.value.item);
            if (outcome.value.model) lastModel = outcome.value.model;
          } else {
            console.error('round1 persona failed', outcome.reason);
          }
        }
        if (!collected.length) throw new Error('Round 1 produced no answers');
        model = lastModel ?? model;
        d.state.round1 = orderItems(collected, personas);
      } else {
        const rendered = renderPrompt('round1', {
          question: d.question,
          language: lang === 'ar' ? 'Arabic' : 'English',
          word_limit: ctx.settings.persona_word_limit,
          today: isoDate(),
          safety_line: safetyLine(d.question, lang),
          persona_blocks: personas.map((p) => d.state.blocks?.[p.id] ?? '').join('\n\n'),
        });
        const { system, user } = splitSystemUser(rendered);
        const res = await llm(ctx, {
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          modelOverride: personas.find((p) => p.model_override)?.model_override ?? null,
          label: 'round1',
          temperature: 0.85,
          maxTokens: 3000,
        });
        requests++;
        model = res.model;
        d.state.round1 = parseRound1(
          res.text,
          personas,
          refsByPersona,
          ctx.settings.persona_word_limit,
          lang,
        );
        for (const item of d.state.round1) {
          const p = personas.find((x) => x.id === item.personaId);
          if (!p) continue;
          await addMessage(ctx, {
            debate_id: d.id,
            persona_id: p.id,
            round: 1,
            role: 'persona',
            answer: item.answer,
            body: item.reasoning,
            citations: item.citations,
            inference: item.inference,
            model: res.model,
          });
        }
      }

      d.state.sent = { ...(d.state.sent ?? {}), round1: true };
      await updateDebate(ctx, d.id, { state: d.state, stage: 'round2', model: model ?? undefined });
    } else if (!d.state.sent?.round1) {
      for (const item of d.state.round1) {
        const p = personas.find((x) => x.id === item.personaId);
        if (p) await safeSend(ctx, d.chat_id, renderPersonaAnswer(p, item, lang));
      }
      d.state.sent = { ...(d.state.sent ?? {}), round1: true };
      await updateDebate(ctx, d.id, { state: d.state, stage: 'round2' });
    } else {
      await updateDebate(ctx, d.id, { stage: 'round2' });
    }
    d.stage = 'round2';
  }

  // ---------------- Round 2 (/dig skips it: Round 1 + Scribe only)
  const wantsRound2 = ctx.settings.rounds >= 2 && d.mode !== 'dig';
  if (wantsRound2 && stageIndex(d.stage) <= stageIndex('round2')) {
    if (!d.state.round2) {
      const res = await llm(ctx, {
        messages: buildRoundMessages(d, personas, d.state.round1 ?? [], lang, ctx.settings.persona_word_limit),
        label: 'round2',
        temperature: 0.85,
        maxTokens: 2600,
      });
      requests++;
      model = res.model;
      d.state.round2 = parseRound2(res.text, personas, d.state.round1 ?? [], ctx.settings.persona_word_limit);
      await updateDebate(ctx, d.id, { state: d.state, model: res.model });

      for (const item of d.state.round2) {
        const p = personas.find((x) => x.id === item.personaId);
        await addMessage(ctx, {
          debate_id: d.id,
          persona_id: item.personaId,
          round: 2,
          role: 'persona',
          answer: item.answer,
          body: item.reply,
          model: res.model,
        });
        if (p) await safeSend(ctx, d.chat_id, renderPersonaReply(p, item, lang, 2));
      }
    } else if (!d.state.sent?.round2) {
      for (const item of d.state.round2) {
        const p = personas.find((x) => x.id === item.personaId);
        if (p) await safeSend(ctx, d.chat_id, renderPersonaReply(p, item, lang, 2));
      }
      d.state.sent = { ...(d.state.sent ?? {}), round2: true };
      await updateDebate(ctx, d.id, { state: d.state, stage: 'scribe' });
    } else {
      await updateDebate(ctx, d.id, { stage: 'scribe' });
    }
    d.stage = 'scribe';
  }

  // ---------------- Scribe
  if (stageIndex(d.stage) <= stageIndex('scribe')) {
    if (!d.state.scribe) {
      const { scribe, model: scribeModel, requests: n } = await runScribe(ctx, d);
      d.state.scribe = scribe;
      requests += n;
      model = scribeModel;
    }
    if (!d.state.sent?.scribe) {
      await sendScribe(ctx, d, d.state.scribe, personas);
      d.state.sent = { ...(d.state.sent ?? {}), scribe: true };
      await updateDebate(ctx, d.id, { state: d.state, stage: 'pack' });
    } else {
      await updateDebate(ctx, d.id, { stage: 'pack' });
    }
    d.stage = 'pack';
  }

  // ---------------- NotebookLM pack (sent in chat, every debate)
  if (stageIndex(d.stage) <= stageIndex('pack')) {
    await sendPack(ctx, d);
    d.state.sent = { ...(d.state.sent ?? {}), pack: true };
    await updateDebate(ctx, d.id, { state: d.state, stage: 'done' });
  }

  await updateDebate(ctx, d.id, {
    stage: 'done',
    status: 'done',
    finished_at: new Date().toISOString(),
    model: model ?? undefined,
  });

  return { model, requests, stage: 'done' };
}

// ---------------------------------------------------------------- context

async function ensureBlocks(
  ctx: Ctx,
  debate: DebateRow,
  personas: PersonaRow[],
  query?: string,
): Promise<{ blocks: Record<string, string>; refsByPersona: Refs }> {
  const blocks: Record<string, string> = { ...(debate.state.blocks ?? {}) };
  const refsByPersona: Refs = {};
  const q = query ?? debate.question;

  for (const persona of personas) {
    const context = await retrieveForPersona(ctx, persona.id, q);
    const block: PersonaBlock = personaBlock(persona, context);
    blocks[persona.id] = block.text;
    refsByPersona[persona.id] = Object.fromEntries(block.refs);
  }
  return { blocks, refsByPersona };
}

function buildSingleMessages(ctx: Ctx, debate: DebateRow, persona: PersonaRow, block: string, lang: 'ar' | 'en') {
  const rendered = renderPrompt('round1_single', {
    question: debate.question,
    language: lang === 'ar' ? 'Arabic' : 'English',
    word_limit: ctx.settings.persona_word_limit,
    today: isoDate(),
    safety_line: safetyLine(debate.question, lang),
    persona_id: persona.id,
    persona_block: block,
  });
  const { system, user } = splitSystemUser(rendered);
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

function buildRoundMessages(
  debate: DebateRow,
  personas: PersonaRow[],
  round1: Round1Item[],
  lang: 'ar' | 'en',
  wordLimit: number,
) {
  const round1Block = round1
    .map((r) => {
      const p = personas.find((x) => x.id === r.personaId);
      return `### ${p?.display_name ?? r.personaId} — ${r.answer.toUpperCase()}\n${r.reasoning}`;
    })
    .join('\n\n');

  const rendered = renderPrompt('round2', {
    question: debate.question,
    language: lang === 'ar' ? 'Arabic' : 'English',
    word_limit: wordLimit,
    round1_block: round1Block,
    persona_blocks: personas
      .map((p) => debate.state.blocks?.[p.id] ?? `### ${p.id} — ${p.display_name}`)
      .join('\n\n'),
  });
  const { system, user } = splitSystemUser(rendered);
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

// ---------------------------------------------------------------- scribe

/**
 * One call. Works for the first exchange and for later turns, because the
 * transcript is rebuilt from the messages table.
 */
export async function runScribe(
  ctx: Ctx,
  debate: DebateRow,
): Promise<{ scribe: ScribeResult; model: string; requests: number }> {
  const personas = await getPersonas(ctx, debate.persona_ids);
  const messages = await listMessages(ctx, debate.id);

  const transcript = messages
    .filter((m) => m.role === 'persona' || m.role === 'user')
    .map((m) => {
      const who =
        m.role === 'user'
          ? 'USER'
          : `${personas.find((p) => p.id === m.persona_id)?.display_name ?? m.persona_id} (${m.persona_id})`;
      const answer = m.answer ? ` [${m.answer.toUpperCase()}]` : '';
      const cites = m.citations?.length ? `\n  sources: ${m.citations.map((c) => c.url).join(', ')}` : '';
      return `ROUND ${m.round} · ${who}${answer}\n${m.body}${cites}`;
    })
    .join('\n\n');

  const rendered = renderPrompt('scribe', {
    question: debate.question,
    language: debate.lang === 'ar' ? 'Arabic' : 'English',
    transcript,
    sources_block: sourcesBlock(
      [],
      uniqueBy(
        messages.flatMap((m) => m.citations ?? []),
        (c) => c.url,
      ),
    ),
  });
  const { system, user } = splitSystemUser(rendered);

  const res = await llm(ctx, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    label: 'scribe',
    temperature: 0.4,
    maxTokens: 1800,
  });

  const scribe = parseScribe(res.text, debate, personas, debate.lang);
  await updateDebate(ctx, debate.id, { state: { ...debate.state, scribe }, scribe, hashtags: scribe.hashtags, model: res.model });
  await addMessage(ctx, {
    debate_id: debate.id,
    round: 99,
    role: 'scribe',
    body: JSON.stringify(scribe),
    model: res.model,
  });
  await recordHashtags(ctx, scribe.hashtags, debate.id).catch(() => {});
  return { scribe, model: res.model, requests: 1 };
}

async function sendScribe(ctx: Ctx, debate: DebateRow, scribe: ScribeResult, personas: PersonaRow[]): Promise<void> {
  await safeSend(
    ctx,
    debate.chat_id,
    renderScribe(scribe, {
      lang: debate.lang,
      personas,
      question: debate.question,
      debateId: debate.id,
    }),
  );
}

async function sendPack(ctx: Ctx, debate: DebateRow): Promise<void> {
  try {
    const pack = await buildNotebookPack(ctx, debate);
    if (!pack) return;
    if (debate.chat_id) {
      await sendDocument(ctx.env, debate.chat_id, pack.filename, pack.markdown, `📓 ${pack.caption}`);
      if (pack.sourcesTxt.trim()) {
        await sendDocument(ctx.env, debate.chat_id, 'sources.txt', pack.sourcesTxt, '🔗 sources.txt');
      }
      if (pack.driveUrl) {
        await safeSend(ctx, debate.chat_id, `📗 Google Doc for NotebookLM: ${pack.driveUrl}`);
      }
    }
  } catch (e) {
    console.error('notebook pack failed', e);
  }
}

// ---------------------------------------------------------------- turns

/** A follow-up message in the same conversation: reply + refresh the summary. */
export async function executeUserTurn(
  ctx: Ctx,
  debate: DebateRow,
  text: string,
): Promise<{ model: string; requests: number }> {
  const personas = (await getPersonas(ctx, debate.persona_ids)).filter((p) => p.enabled);
  const messages = await listMessages(ctx, debate.id);
  const round = Math.max(1, ...messages.map((m) => m.round === 99 ? 0 : m.round)) + 1;

  await addMessage(ctx, { debate_id: debate.id, round, role: 'user', body: text });

  const rounds = messages.filter((m) => m.role === 'persona' && m.round !== 99);
  const latest = rounds.slice(-personas.length);
  const priorBlock = latest
    .map((m) => {
      const p = personas.find((x) => x.id === m.persona_id);
      return `${p?.display_name ?? m.persona_id} (${m.answer ?? '—'}): ${m.body}`;
    })
    .join('\n\n');

  // Refresh context for the new message, keeping the original question in play.
  const { blocks } = await ensureBlocks(ctx, debate, personas, `${debate.question} ${text}`);
  const state: DebateState = { ...debate.state, blocks };

  const rendered = renderPrompt('round2', {
    question: debate.question,
    language: debate.lang === 'ar' ? 'Arabic' : 'English',
    word_limit: ctx.settings.persona_word_limit,
    round1_block: `${priorBlock}\n\nTHE USER HAS NOW SAID:\n"${text}"\n\nRespond directly to the user, and to each other where relevant.`,
    persona_blocks: personas.map((p) => blocks[p.id] ?? `### ${p.id} — ${p.display_name}`).join('\n\n'),
  });
  const { system, user } = splitSystemUser(rendered);

  const res = await llm(ctx, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    label: 'user_turn',
    temperature: 0.8,
    maxTokens: 2400,
  });

  const items = parseRound2(res.text, personas, state.round1 ?? [], ctx.settings.persona_word_limit);
  for (const item of items) {
    await addMessage(ctx, {
      debate_id: debate.id,
      persona_id: item.personaId,
      round,
      role: 'persona',
      answer: item.answer,
      body: item.reply,
      model: res.model,
    });
    const p = personas.find((x) => x.id === item.personaId);
    if (p) await safeSend(ctx, debate.chat_id, renderPersonaReply(p, item, debate.lang, round));
  }

  await updateDebate(ctx, debate.id, { state: { ...state, extra: [...(state.extra ?? []), { round, items }] } });

  // The last agent always closes the turn.
  const fresh = await getDebateFor(ctx, debate.id, state);
  const { scribe } = await runScribe(ctx, fresh);
  await sendScribe(ctx, fresh, scribe, personas);

  return { model: res.model, requests: 2 };
}

async function getDebateFor(ctx: Ctx, id: string, state: DebateState): Promise<DebateRow> {
  const { getDebate } = await import('../db/repo');
  const d = await getDebate(ctx, id);
  return d ? { ...d, state } : ({ id, state } as DebateRow);
}

/** /more — one more rebuttal round on the same debate. */
export async function executeExtraRound(ctx: Ctx, debate: DebateRow): Promise<{ model: string; requests: number }> {
  const personas = (await getPersonas(ctx, debate.persona_ids)).filter((p) => p.enabled);
  const messages = await listMessages(ctx, debate.id);
  const round = Math.max(2, ...messages.map((m) => (m.round === 99 ? 0 : m.round))) + 1;

  const res = await llm(ctx, {
    messages: buildRoundMessages(debate, personas, debate.state.round1 ?? [], debate.lang, ctx.settings.persona_word_limit),
    label: `extra:${round}`,
    temperature: 0.85,
    maxTokens: 2600,
  });

  const items = parseRound2(res.text, personas, debate.state.round1 ?? [], ctx.settings.persona_word_limit);
  for (const item of items) {
    await addMessage(ctx, {
      debate_id: debate.id,
      persona_id: item.personaId,
      round,
      role: 'persona',
      answer: item.answer,
      body: item.reply,
      model: res.model,
    });
    const p = personas.find((x) => x.id === item.personaId);
    if (p) await safeSend(ctx, debate.chat_id, renderPersonaReply(p, item, debate.lang, round));
  }

  const state = { ...debate.state, extra: [...(debate.state.extra ?? []), { round, items }] };
  await updateDebate(ctx, debate.id, { state });
  return { model: res.model, requests: 1 };
}

/** /end — final summary + a fresh pack, then close the thread. */
export async function finishDebateSession(ctx: Ctx, debate: DebateRow): Promise<{ requests: number }> {
  const personas = await getPersonas(ctx, debate.persona_ids);
  const { scribe } = await runScribe(ctx, debate);
  await sendScribe(ctx, debate, scribe, personas);
  const fresh = (await getDebateFor(ctx, debate.id, debate.state)) as DebateRow;
  await sendPack(ctx, { ...fresh, scribe } as DebateRow);
  await updateDebate(ctx, debate.id, { status: 'done', stage: 'done', finished_at: new Date().toISOString() });
  return { requests: 1 };
}

// ---------------------------------------------------------------- parsing

export function parseRound1(
  raw: string,
  personas: PersonaRow[],
  refsByPersona: Refs,
  wordLimit: number,
  lang: 'ar' | 'en',
): Round1Item[] {
  const parsed = extractJson<unknown>(raw);
  const arr = Array.isArray(parsed)
    ? (parsed as Record<string, unknown>[])
    : parsed && typeof parsed === 'object' && ('persona_id' in (parsed as object) || 'answer' in (parsed as object))
      ? [parsed as Record<string, unknown>]
      : asArray<Record<string, unknown>>(parsed);
  const byId = new Map(arr.map((item) => [str(item.persona_id ?? item.personaId ?? item.id), item]));

  return personas.map((p) => {
    const item = byId.get(p.id) ?? (personas.length === 1 ? arr[0] : undefined);
    const refs = new Map(Object.entries(refsByPersona[p.id] ?? {}));
    if (!item) {
      return {
        personaId: p.id,
        answer: 'depends' as Answer,
        reasoning:
          lang === 'ar'
            ? 'لم أستطع تكوين موقف واضح من المصادر المتاحة.'
            : 'I could not form a clear position from the available sources.',
        citations: [],
        inference: true,
      };
    }
    const citations = resolveCitations(item.citations ?? item.sources, refs);
    const explicitInference = item.inference === true;
    const reasoning = limitWords(str(item.reasoning ?? item.answer_text ?? item.text), wordLimit);
    return {
      personaId: p.id,
      answer: oneOf(item.answer, ['yes', 'no', 'depends'] as const, 'depends'),
      reasoning: reasoning || (lang === 'ar' ? 'لا يوجد تعليق.' : 'No comment.'),
      citations,
      inference: explicitInference || citations.length === 0,
      inferenceNote: str(item.inference_note ?? item.inferenceNote) || undefined,
    };
  });
}

export function parseRound2(
  raw: string,
  personas: PersonaRow[],
  round1: Round1Item[],
  wordLimit: number,
): Round2Item[] {
  const parsed = extractJson<unknown>(raw);
  const arr = asArray<Record<string, unknown>>(parsed);
  const byId = new Map(arr.map((item) => [str(item.persona_id ?? item.personaId ?? item.id), item]));

  return personas.map((p) => {
    const item = byId.get(p.id);
    const prev = round1.find((r) => r.personaId === p.id);
    const reply = limitWords(str(item?.reply ?? item?.reasoning ?? item?.text), wordLimit);
    return {
      personaId: p.id,
      reply: reply || (prev ? prev.reasoning : '…'),
      reaction: oneOf(item?.reaction, ['agree', 'push_back', 'change_mind'] as const, 'push_back'),
      answer: oneOf(item?.answer, ['yes', 'no', 'depends'] as const, prev?.answer ?? 'depends'),
    };
  });
}

export function parseScribe(raw: string, debate: DebateRow, personas: PersonaRow[], lang: 'ar' | 'en'): ScribeResult {
  const parsed = extractJson<Record<string, unknown>>(raw) ?? {};
  const verdictSrc = asArray<Record<string, unknown>>(parsed.verdicts);
  const round1 = debate.state.round1 ?? [];

  const verdicts = personas.map((p) => {
    const found = verdictSrc.find((v) => str(v.persona_id ?? v.personaId ?? v.id) === p.id);
    const fromRound1 = round1.find((r) => r.personaId === p.id);
    return {
      persona_id: p.id,
      answer: oneOf(found?.answer ?? fromRound1?.answer, ['yes', 'no', 'depends'] as const, 'depends'),
      top_reason: str(found?.top_reason ?? found?.reason ?? found?.topReason).slice(0, 240),
    };
  });

  let hashtags = (Array.isArray(parsed.hashtags) ? parsed.hashtags : [])
    .map((h) => cleanHashtag(String(h)))
    .filter((h): h is string => !!h);
  hashtags = uniqueBy(hashtags, (h) => h).slice(0, 5);
  while (hashtags.length < 5) {
    const base = ['council', 'debate', 'analysis', 'sources', 'followup'][hashtags.length] ?? `tag${hashtags.length}`;
    const candidate = cleanHashtag(`${base}_${debate.id.slice(-4)}`)!;
    if (!hashtags.includes(candidate)) hashtags.push(candidate);
    else break;
  }

  const nextSteps = (Array.isArray(parsed.next_steps) ? parsed.next_steps : [])
    .map((s) => str(s))
    .filter(Boolean)
    .slice(0, 3);
  while (nextSteps.length < 3) {
    nextSteps.push(lang === 'ar' ? 'راجع المصادر المذكورة أعلاه بنفسك.' : 'Read the cited sources yourself.');
  }

  const keywords = (parsed.search_keywords ?? {}) as Record<string, unknown>;
  const disclaimerRaw = str(parsed.disclaimer);
  const disclaimer =
    disclaimerRaw && disclaimerRaw.toLowerCase() !== 'null'
      ? disclaimerRaw
      : isSensitiveQuestion(debate.question)
        ? defaultFooter(lang)
        : null;

  return {
    headline: str(parsed.headline).slice(0, 200),
    verdicts,
    agreements: (Array.isArray(parsed.agreements) ? parsed.agreements : []).map((s) => str(s)).filter(Boolean).slice(0, 3),
    disagreements: (Array.isArray(parsed.disagreements) ? parsed.disagreements : [])
      .map((s) => str(s))
      .filter(Boolean)
      .slice(0, 3),
    next_steps: nextSteps,
    hashtags,
    search_keywords: {
      ar: (Array.isArray(keywords.ar) ? keywords.ar : []).map((s) => str(s)).filter(Boolean).slice(0, 6),
      en: (Array.isArray(keywords.en) ? keywords.en : []).map((s) => str(s)).filter(Boolean).slice(0, 6),
    },
    disclaimer,
  };
}

export function resolveCitations(raw: unknown, refs: Map<string, Citation>): Citation[] {
  const out: Citation[] = [];
  const byUrl = new Map([...refs.values()].map((c) => [c.url, c]));
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      const c = refs.get(entry.trim().toUpperCase());
      if (c) out.push(c);
      continue;
    }
    if (entry && typeof entry === 'object') {
      const obj = entry as Record<string, unknown>;
      const ref = str(obj.ref ?? obj.source_id ?? obj.id).toUpperCase();
      if (ref && refs.has(ref)) {
        out.push(refs.get(ref)!);
        continue;
      }
      const url = str(obj.url);
      if (url && byUrl.has(url)) out.push(byUrl.get(url)!);
    }
  }
  return uniqueBy(out, (c) => c.url);
}

// ---------------------------------------------------------------- helpers

function itemFromMessage(m: MessageRow): Round1Item {
  return {
    personaId: m.persona_id ?? '',
    answer: (m.answer ?? 'depends') as Answer,
    reasoning: m.body,
    citations: m.citations ?? [],
    inference: !!m.inference,
  };
}

function orderItems(items: Round1Item[], personas: PersonaRow[]): Round1Item[] {
  const out: Round1Item[] = [];
  for (const p of personas) {
    const found = items.find((i) => i.personaId === p.id);
    if (found) out.push(found);
  }
  for (const i of items) if (!out.includes(i)) out.push(i);
  return out;
}

async function safeSend(ctx: Ctx, chatId: number | null, html: string): Promise<void> {
  if (!chatId) return;
  try {
    await sendMessage(ctx.env, chatId, html);
  } catch (e) {
    console.error('telegram send failed', e);
  }
}

function stageIndex(stage: string): number {
  const idx = STAGES.indexOf(stage as Stage);
  return idx === -1 ? 0 : idx;
}

export function isoDate(): string {
  return new Date().toISOString().slice(0, 10);
}
