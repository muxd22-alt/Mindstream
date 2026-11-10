import type { Citation, Ctx, DebateRow, MessageRow, ScribeResult } from '../types';
import { getPersonas, listMessages } from '../db/repo';
import { answerLabel } from './labels';
import { driveConfigured, markdownToHtml, packTitle, uploadGoogleDoc } from './drive';
import { uniqueBy } from '../util/text';

export interface NotebookPack {
  filename: string;
  markdown: string;
  sourcesTxt: string;
  caption: string;
  driveUrl?: string;
}

/**
 * NotebookLM has no public API, so we produce exactly what it ingests well:
 * one Markdown file with the whole debate, plus a plain URL list.
 * If Drive is configured we also push a Google Doc into the chosen folder.
 */
export async function buildNotebookPack(
  ctx: Ctx,
  debate: DebateRow,
  opts: { upload?: boolean } = {},
): Promise<NotebookPack | null> {
  const personas = await getPersonas(ctx, debate.persona_ids);
  const messages = await listMessages(ctx, debate.id);
  const scribe: ScribeResult | null = debate.scribe ?? debate.state.scribe ?? null;

  const nameOf = (id: string | null) => {
    const p = personas.find((x) => x.id === id);
    return p ? `${p.emoji} ${p.display_name}` : (id ?? 'Council');
  };

  const personaMessages = messages.filter((m) => m.role === 'persona');
  if (!personaMessages.length) return null;

  const byRound = new Map<number, MessageRow[]>();
  for (const m of personaMessages) {
    const list = byRound.get(m.round) ?? [];
    list.push(m);
    byRound.set(m.round, list);
  }

  const allCitations: Citation[] = uniqueBy(
    personaMessages.flatMap((m) => m.citations ?? []),
    (c) => c.url,
  );

  const lines: string[] = [];
  lines.push(`# Council debate — ${packTitle(debate.question)}`);
  lines.push('');
  lines.push(`- **Question:** ${debate.question}`);
  lines.push(`- **Date:** ${(debate.created_at || new Date().toISOString()).slice(0, 10)}`);
  lines.push(`- **Language:** ${debate.lang === 'ar' ? 'Arabic' : 'English'}`);
  lines.push(`- **Mode:** ${debate.mode}`);
  lines.push(`- **Debate ID:** \`${debate.id}\``);
  lines.push(`- **Personas:** ${personas.map((p) => p.display_name).join(', ')}`);
  lines.push(`- **Model(s):** ${[...new Set(personaMessages.map((m) => m.model).filter(Boolean))].join(', ') || 'n/a'}`);
  lines.push('');
  lines.push(
    '> **All persona statements below are simulations** built from documented public statements. ' +
      'They are not the real people and they are not quotes unless marked as such.',
  );
  lines.push('');

  const rounds = [...byRound.keys()].sort((a, b) => a - b);
  for (const round of rounds) {
    lines.push(`## Round ${round}`);
    lines.push('');
    for (const m of byRound.get(round) ?? []) {
      lines.push(`### ${nameOf(m.persona_id)} — ${answerLabel(m.answer, debate.lang)}`);
      lines.push('');
      lines.push(m.body.trim());
      lines.push('');
      if (m.citations?.length) {
        lines.push('Sources:');
        for (const c of m.citations) {
          lines.push(`- [${c.title || c.url}](${c.url})${c.date ? ` — ${c.date}` : ''}`);
        }
        lines.push('');
      }
      if (m.inference) {
        lines.push('_Marked as inference: no stored source covered this specific question._');
        lines.push('');
      }
    }
  }

  if (scribe) {
    lines.push('## Scribe summary');
    lines.push('');
    if (scribe.headline) {
      lines.push(`**${scribe.headline}**`);
      lines.push('');
    }
    lines.push('| Persona | Answer | Top reason |');
    lines.push('|---|---|---|');
    for (const v of scribe.verdicts) {
      lines.push(`| ${nameOf(v.persona_id)} | ${answerLabel(v.answer, debate.lang)} | ${v.top_reason.replace(/\|/g, '/')} |`);
    }
    lines.push('');
    if (scribe.agreements.length) {
      lines.push('### Where they agree');
      for (const a of scribe.agreements) lines.push(`- ${a}`);
      lines.push('');
    }
    if (scribe.disagreements.length) {
      lines.push('### Where they disagree');
      for (const a of scribe.disagreements) lines.push(`- ${a}`);
      lines.push('');
    }
    if (scribe.next_steps.length) {
      lines.push('### Next steps');
      scribe.next_steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
      lines.push('');
    }
    if (scribe.hashtags.length) {
      lines.push(`### Hashtags`);
      lines.push(scribe.hashtags.join(' '));
      lines.push('');
    }
    if (scribe.search_keywords.en.length || scribe.search_keywords.ar.length) {
      lines.push('### Search keywords');
      lines.push(`- English: ${scribe.search_keywords.en.join(', ')}`);
      lines.push(`- Arabic: ${scribe.search_keywords.ar.join(', ')}`);
      lines.push('');
    }
    if (scribe.disclaimer) {
      lines.push(`> ⚠️ ${scribe.disclaimer}`);
      lines.push('');
    }
  }

  lines.push('## All sources');
  lines.push('');
  if (allCitations.length) {
    allCitations.forEach((c, i) => {
      lines.push(`${i + 1}. ${c.title || 'Untitled'}${c.date ? ` — ${c.date}` : ''} — ${c.url}`);
    });
  } else {
    lines.push('_No external sources were cited; all answers were marked as inference._');
  }
  lines.push('');

  const markdown = lines.join('\n');
  const sourcesTxt = allCitations.length ? allCitations.map((c) => c.url).join('\n') + '\n' : '';

  const stamp = (debate.created_at || new Date().toISOString()).slice(0, 10);
  const filename = `council-${stamp}-${debate.id.slice(-6)}.md`;

  let driveUrl: string | undefined;
  if (opts.upload !== false && (await driveConfigured(ctx.env))) {
    const html = markdownToHtml(markdown, `Council — ${packTitle(debate.question)}`);
    driveUrl = (await uploadGoogleDoc(ctx.env, `${filename.replace(/\.md$/, '')}`, html)) ?? undefined;
  }

  return {
    filename,
    markdown,
    sourcesTxt,
    caption: `NotebookLM pack · ${allCitations.length} source(s) · ${personaMessages.length} statements`,
    driveUrl,
  };
}
