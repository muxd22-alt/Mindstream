import type { Ctx, PersonaRow } from '../types';
import {
  addMessage,
  createDebate,
  findOpenThread,
  getPersona,
  recentMessagesForThread,
  updateDebate,
} from '../db/repo';
import { beliefsBlock, retrieveForPersona } from '../rag/retrieve';
import { llm } from '../llm/openrouter';
import { renderPrompt, splitSystemUser } from '../prompts';
import { sendMessage } from '../telegram/api';
import { personaHeader, simulationTag } from '../telegram/format';
import { escapeHtml, limitWords, uniqueBy } from '../util/text';
import { defaultFooter, isSensitiveQuestion, responseLanguage, safetyLine } from '../util/safety';

export interface ChatResult {
  model: string;
  debateId: string;
  reply: string;
}

/** /chat <persona> — 1:1 conversation with its own memory thread and the same RAG. */
export async function runChatTurn(
  ctx: Ctx,
  input: { chatId: number; userId: number; personaId: string; text: string },
): Promise<ChatResult> {
  const persona = await getPersona(ctx, input.personaId);
  if (!persona) throw new Error(`No persona "${input.personaId}". Try /personas.`);
  if (!persona.enabled) throw new Error(`${persona.display_name} is switched off.`);

  const threadKey = `chat:${input.chatId}:${persona.id}`;
  let thread = await findOpenThread(ctx, threadKey);
  if (!thread) {
    thread = await createDebate(ctx, {
      chat_id: input.chatId,
      user_id: input.userId,
      question: input.text.slice(0, 500),
      lang: responseLanguage(input.text, ctx.settings),
      mode: 'chat_thread',
      persona_ids: [persona.id],
      thread_key: threadKey,
    });
    await updateDebate(ctx, thread.id, { status: 'open' });
  }

  const lang = responseLanguage(input.text, ctx.settings);
  const history = await recentMessagesForThread(ctx, thread.id, 10);
  const context = await retrieveForPersona(ctx, persona.id, input.text, { chunks: 5, beliefs: 4 });

  const historyBlock =
    history.length > 0
      ? history
          .map((m) => `${m.role === 'user' ? 'User' : persona.display_name}: ${m.body}`)
          .join('\n')
      : '(this is the first message)';

  const sourcesText = context.chunks.length
    ? context.chunks
        .map((c) => `- ${c.title}${c.published_at ? ` (${c.published_at.slice(0, 10)})` : ''} — ${c.url}\n  ${c.content.slice(0, 400)}`)
        .join('\n')
    : '(none)';

  const rendered = renderPrompt('chat', {
    persona_name: persona.display_name,
    language: lang === 'ar' ? 'Arabic' : 'English',
    word_limit: ctx.settings.persona_word_limit,
    safety_line: safetyLine(input.text, lang),
    persona_block: [
      `### ${persona.id} — ${persona.display_name}`,
      `BIO: ${persona.bio}`,
      `STYLE: ${persona.speaking_style}`,
      persona.core_values.length ? `VALUES: ${persona.core_values.join('; ')}` : '',
      persona.known_biases.length ? `BIASES: ${persona.known_biases.join('; ')}` : '',
      persona.topics_of_expertise.length ? `EXPERTISE: ${persona.topics_of_expertise.join('; ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    sources_block: sourcesText,
    beliefs_block: beliefsBlock(context.beliefs),
    history_block: historyBlock,
    message: input.text,
  });
  const { system, user } = splitSystemUser(rendered);

  const res = await llm(ctx, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    modelOverride: persona.model_override,
    label: 'chat',
    temperature: 0.85,
    maxTokens: 900,
  });

  const reply = limitWords(res.text.trim(), ctx.settings.persona_word_limit * 2);

  await addMessage(ctx, { debate_id: thread.id, round: 1, role: 'user', body: input.text, model: res.model });
  await addMessage(ctx, {
    debate_id: thread.id,
    persona_id: persona.id,
    round: 1,
    role: 'persona',
    body: reply,
    model: res.model,
  });

  const links = uniqueBy(context.chunks, (c) => c.url).slice(0, 3);
  const html = [
    personaHeader(persona, lang),
    escapeHtml(reply),
    links.length
      ? `\n📎 ${links
          .map((c) => `<a href="${escapeHtml(c.url)}">${escapeHtml(c.title)}</a>${c.published_at ? ` (${c.published_at.slice(0, 10)})` : ''}`)
          .join('\n📎 ')}`
      : `\n🧪 <i>${lang === 'ar' ? 'استنتاج — لا يوجد مصدر مخزّن عن هذا الموضوع.' : 'Inference — no stored source on this topic.'}</i>`,
    isSensitiveQuestion(input.text) ? `\n<i>${escapeHtml(defaultFooter(lang))}</i>` : '',
    `<i>· ${simulationTag(lang)}</i>`,
  ]
    .filter(Boolean)
    .join('\n');

  await sendMessage(ctx.env, input.chatId, html);
  return { model: res.model, debateId: thread.id, reply };
}

export function personaOptions(persona: PersonaRow): string {
  return `id: ${persona.id} · ${persona.display_name} ${persona.emoji} · ${persona.enabled ? 'on' : 'off'}`;
}
