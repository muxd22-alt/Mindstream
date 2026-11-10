import type { Ctx } from '../types';
import { fetchGoogleNews } from '../sources/googlenews';
import { llm } from '../llm/openrouter';
import { renderPrompt } from '../prompts';
import { parsePersonaYaml, normalizeId } from '../personas/loader';
import { saveDraft } from '../db/repo';

export interface DraftResult {
  draftId: string;
  personaId: string;
  yaml: string;
}

/**
 * /persona add <name> — a web/news sweep becomes a draft YAML.
 * Nothing is written to `personas` until the owner approves it in the Mini App.
 */
export async function draftPersona(ctx: Ctx, name: string, hint?: string): Promise<DraftResult> {
  const clean = name.trim().slice(0, 80);
  if (!clean) throw new Error('Usage: /persona add <name>');

  const sweeps = await Promise.all([
    fetchGoogleNews({ type: 'googlenews', query: `"${clean}"`, label: 'draft-en' }, 10),
    fetchGoogleNews({ type: 'googlenews', query: `"${clean}"`, label: 'draft-ar' }, 6),
  ]);

  const seen = new Set<string>();
  const items = sweeps
    .flatMap((s) => s.docs)
    .filter((d) => {
      if (seen.has(d.url)) return false;
      seen.add(d.url);
      return true;
    })
    .slice(0, 12);

  if (!items.length) {
    throw new Error(`No web results for "${clean}". Try a fuller name.`);
  }

  const sweep = items
    .map((d, i) => `[${i}] ${d.title}${d.publishedAt ? ` (${d.publishedAt.slice(0, 10)})` : ''}\n${d.content.slice(0, 400)}\n${d.url}`)
    .join('\n\n');

  const rendered = renderPrompt('persona_draft', {
    name: clean,
    hint_line: hint ? `Extra context from the owner: ${hint}` : '',
    sweep,
  });

  const res = await llm(ctx, {
    messages: [{ role: 'user', content: rendered }],
    label: 'persona_draft',
    temperature: 0.5,
    maxTokens: 1200,
  });

  const yaml = stripFence(res.text);
  const personaId = normalizeId(clean) || `persona_${Date.now().toString(36)}`;
  const parsed = parsePersonaYaml(yaml, personaId);
  // The draft must use the requested name/id, not whatever the model invented.
  parsed.id = personaId;
  parsed.display_name = clean;
  if (!parsed.source_feeds.length) {
    parsed.source_feeds = [
      { type: 'googlenews', query: `"${clean}"`, label: 'google-news-en' },
      { type: 'googlenews', query: `"${clean}"`, label: 'google-news-ar' },
    ];
  }

  const { stringify } = await import('yaml');
  const normalizedYaml = stringify(
    {
      id: parsed.id,
      display_name: parsed.display_name,
      emoji: parsed.emoji,
      bio: parsed.bio,
      speaking_style: parsed.speaking_style,
      core_values: parsed.core_values,
      known_biases: parsed.known_biases,
      topics_of_expertise: parsed.topics_of_expertise,
      model_override: parsed.model_override ?? null,
      enabled: true,
      source_feeds: parsed.source_feeds,
    },
    { lineWidth: 100 },
  );

  const draftId = await saveDraft(ctx, {
    persona_id: parsed.id,
    yaml: normalizedYaml,
    payload: { name: clean, sources: items.slice(0, 5).map((d) => ({ title: d.title, url: d.url })), model: res.model },
  });

  return { draftId, personaId: parsed.id, yaml: normalizedYaml };
}

function stripFence(text: string): string {
  const fence = text.match(/```(?:ya?ml)?\s*([\s\S]*?)```/i);
  return (fence?.[1] ?? text).trim();
}
