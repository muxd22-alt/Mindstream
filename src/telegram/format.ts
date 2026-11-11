import type { Persona, Round1Item, Round2Item, ScribeResult, Answer, Citation } from '../types';
import { escapeHtml } from '../util/text';

export function answerChip(answer: Answer, lang: 'ar' | 'en'): string {
  const map: Record<Answer, { en: string; ar: string }> = {
    yes: { en: '✅ YES', ar: '✅ نعم' },
    no: { en: '❌ NO', ar: '❌ لا' },
    depends: { en: '🤔 DEPENDS', ar: '🤔 يعتمد' },
  };
  return map[answer]?.[lang] ?? String(answer).toUpperCase();
}

export function simulationTag(lang: 'ar' | 'en'): string {
  return lang === 'ar' ? 'محاكاة' : 'simulated';
}

export function personaHeader(persona: Pick<Persona, 'display_name' | 'emoji'>, lang: 'ar' | 'en', round?: number): string {
  const r = round && round > 2 ? ` · ${lang === 'ar' ? 'جولة' : 'round'} ${round}` : '';
  return `${persona.emoji} <b>${escapeHtml(persona.display_name)}</b> <i>· ${simulationTag(lang)}${r}</i>`;
}

export function citationsBlock(citations: Citation[], lang: 'ar' | 'en'): string {
  if (!citations.length) return '';
  const lines = citations.map((c) => {
    const label = escapeHtml(c.title || c.url);
    const date = c.date ? ` (${escapeHtml(c.date)})` : '';
    return `📎 <a href="${escapeHtml(c.url)}">${label}</a>${date}`;
  });
  return `\n${lines.join('\n')}`;
}

export function inferenceNote(text: string | undefined, lang: 'ar' | 'en'): string {
  const note = text?.trim();
  if (note) return `\n🧪 <i>${escapeHtml(note)}</i>`;
  return lang === 'ar'
    ? '\n🧪 <i>استنتاج — لا يوجد مصدر مخزّن عن هذا الموضوع؛ الرأي مبني على الروح العامة لمواقفه المعروفة.</i>'
    : '\n🧪 <i>Inference — no stored source on this topic; reasoning back from known views.</i>';
}

export function renderPersonaAnswer(
  persona: Persona,
  item: Round1Item,
  lang: 'ar' | 'en',
): string {
  const parts: string[] = [];
  parts.push(personaHeader(persona, lang));
  parts.push(`<b>${answerChip(item.answer, lang)}</b>`);
  parts.push('');
  parts.push(escapeHtml(item.reasoning));
  const cites = citationsBlock(item.citations, lang);
  if (cites) parts.push(cites);
  if (item.inference || !item.citations.length) parts.push(inferenceNote(item.inferenceNote, lang));
  return parts.join('\n');
}

export function renderPersonaReply(
  persona: Persona,
  item: Round2Item,
  lang: 'ar' | 'en',
  round: number,
): string {
  const reaction =
    item.reaction === 'agree'
      ? lang === 'ar' ? '🤝 يوافق' : '🤝 agrees'
      : item.reaction === 'change_mind'
        ? lang === 'ar' ? '🔄 يغيّر رأيه' : '🔄 changed mind'
        : lang === 'ar' ? '⚡ يعترض' : '⚡ pushes back';

  return [
    personaHeader(persona, lang, round),
    `<i>${reaction}</i> · <b>${answerChip(item.answer, lang)}</b>`,
    item.ranking?.length
      ? `<i>🕶 Blind review · ${item.ranking.map((r) => `${escapeHtml(r.viewId)} #${r.rank}${r.rationale ? ` — ${escapeHtml(r.rationale)}` : ''}`).join(' · ')}</i>`
      : '',
    '',
    escapeHtml(item.reply),
    item.citations?.length ? citationsBlock(item.citations, lang) : '',
    item.inference ? inferenceNote(undefined, lang) : '',
  ].filter(Boolean).join('\n');
}

export function renderScribe(
  scribe: ScribeResult,
  opts: { lang: 'ar' | 'en'; personas: Persona[]; question: string; debateId: string },
): string {
  const { lang, personas, question } = opts;
  const byId = new Map(personas.map((p) => [p.id, p]));
  const L = (en: string, ar: string) => (lang === 'ar' ? ar : en);
  const parts: string[] = [];

  parts.push(`📋 <b>${L('Council verdict', 'خلاصة المجلس')}</b>`);
  if (scribe.headline) parts.push(`<i>${escapeHtml(scribe.headline)}</i>`);
  parts.push(`<blockquote>${escapeHtml(question.slice(0, 300))}</blockquote>`);
  parts.push('');

  if (scribe.synthesis) {
    parts.push(`<b>${L('Scribe synthesis', 'خلاصة الكاتب')}</b>`);
    parts.push(escapeHtml(scribe.synthesis));
    parts.push('');
  }

  if (scribe.peer_review?.length) {
    parts.push(`<b>${L('Blind peer review', 'مراجعة الأقران المجهولة')}</b> <i>${L('(arguments ranked, not people)', '(ترتيب الحجج لا الأشخاص)')}</i>`);
    scribe.peer_review.forEach((r, i) => {
      const p = byId.get(r.personaId);
      const name = p ? `${p.emoji} ${p.display_name}` : r.personaId;
      parts.push(`${i + 1}. ${escapeHtml(name)} — avg #${r.averageRank} · ${r.judges} ${L('peer judges', 'مراجعين')}`);
    });
    parts.push('');
  }

  for (const v of scribe.verdicts) {
    const p = byId.get(v.persona_id);
    const name = p ? `${p.emoji} ${p.display_name}` : v.persona_id;
    parts.push(`<b>${escapeHtml(name)}</b> — ${answerChip(v.answer, lang)}`);
    parts.push(escapeHtml(v.top_reason));
    parts.push('');
  }

  if (scribe.agreements?.length) {
    parts.push(`<b>${L('They agree', 'نقاط الاتفاق')}</b>`);
    for (const a of scribe.agreements.slice(0, 3)) parts.push(`• ${escapeHtml(a)}`);
    parts.push('');
  }
  if (scribe.disagreements?.length) {
    parts.push(`<b>${L('They disagree', 'نقاط الاختلاف')}</b>`);
    for (const a of scribe.disagreements.slice(0, 3)) parts.push(`• ${escapeHtml(a)}`);
    parts.push('');
  }
  if (scribe.next_steps?.length) {
    parts.push(`<b>${L('Your next steps', 'خطواتك التالية')}</b>`);
    scribe.next_steps.slice(0, 3).forEach((s, i) => parts.push(`${i + 1}. ${escapeHtml(s)}`));
    parts.push('');
  }

  const tags = scribe.hashtags?.slice(0, 5) ?? [];
  if (tags.length) {
    parts.push(`<b>${L('Follow up', 'للمتابعة')}</b> ${escapeHtml(tags.join(' '))}`);
    parts.push(L('Tap a hashtag in the Mini App to run /dig.', 'اضغط على الوسم في التطبيق المصغّر لتشغيل /dig.'));
    parts.push('');
  }

  const kw = scribe.search_keywords;
  if (kw && (kw.ar?.length || kw.en?.length)) {
    parts.push(
      `<b>${L('Search keywords', 'كلمات البحث')}</b> ${escapeHtml([...(kw.en ?? []), ...(kw.ar ?? [])].slice(0, 10).join(' · '))}`,
    );
    parts.push('');
  }

  if (scribe.disclaimer) {
    parts.push(`⚠️ <i>${escapeHtml(scribe.disclaimer)}</i>`);
  }
  parts.push(`<code>/notebook ${opts.debateId}</code>`);
  return parts.join('\n');
}

export function progressMessage(lang: 'ar' | 'en', what: string): string {
  const L = (en: string, ar: string) => (lang === 'ar' ? ar : en);
  return `<i>${escapeHtml(what)} — ${L('deliberating', 'جارٍ النقاش')}…</i>`;
}

export function errorMessage(text: string): string {
  return `⚠️ ${escapeHtml(text)}`;
}
