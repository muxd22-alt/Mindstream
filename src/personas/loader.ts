import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Ctx, FeedSpec, FeedKind, Persona, PersonaRow } from '../types';
import { SEED_PERSONAS } from '../generated/personas';
import { ensureSources, getPersona, upsertPersona } from '../db/repo';
import { slugify } from '../util/text';

export const FEED_KINDS: FeedKind[] = ['googlenews', 'rss', 'blog', 'youtube', 'podcast', 'rsshub'];

export class PersonaYamlError extends Error {}

export function parsePersonaYaml(raw: string, idHint?: string): Persona {
  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (e) {
    throw new PersonaYamlError(`YAML is not valid: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new PersonaYamlError('YAML must be a mapping (key: value), not a list or scalar.');
  }
  const d = doc as Record<string, unknown>;

  const displayName = str(d.display_name ?? d.name);
  const rawId = str(d.id) || slugify(displayName) || slugify(idHint ?? '');
  const id = normalizeId(rawId);
  if (!id) throw new PersonaYamlError('Persona needs an `id` (a-z, 0-9, underscore).');
  if (!displayName) throw new PersonaYamlError('Persona needs a `display_name`.');

  return {
    id,
    display_name: displayName.slice(0, 80),
    emoji: str(d.emoji) || '🗣',
    bio: str(d.bio),
    speaking_style: str(d.speaking_style),
    core_values: strArray(d.core_values),
    known_biases: strArray(d.known_biases),
    topics_of_expertise: strArray(d.topics_of_expertise),
    source_feeds: feeds(d.source_feeds),
    model_override: str(d.model_override) || null,
    enabled: d.enabled === undefined ? true : d.enabled !== false && d.enabled !== 'false',
  };
}

function str(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

function strArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter(Boolean).slice(0, 20);
  if (typeof v === 'string') {
    return v
      .split(/[\n,;]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 20);
  }
  return [];
}

function feeds(v: unknown): FeedSpec[] {
  if (!Array.isArray(v)) return [];
  const out: FeedSpec[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    const type = str(f.type).toLowerCase() as FeedKind;
    if (!FEED_KINDS.includes(type)) continue;
    const spec: FeedSpec = {
      type,
      url: str(f.url) || undefined,
      query: str(f.query) || undefined,
      route: str(f.route) || undefined,
      handle: str(f.handle) || undefined,
      channel_id: str(f.channel_id) || undefined,
      label: str(f.label) || undefined,
      enabled: f.enabled === undefined ? true : f.enabled !== false,
    };
    if (type === 'googlenews' && !spec.query) continue;
    if (type === 'rsshub' && !spec.route) continue;
    if ((type === 'rss' || type === 'blog' || type === 'podcast') && !spec.url) continue;
    if (type === 'youtube' && !spec.handle && !spec.channel_id && !spec.url) continue;
    out.push(spec);
  }
  return out;
}

export function normalizeId(raw: string): string {
  const id = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return /^[a-z0-9][a-z0-9_]{0,39}$/.test(id) ? id : '';
}

export function personaToYaml(p: PersonaRow | Persona): string {
  const ordered = {
    id: p.id,
    display_name: p.display_name,
    emoji: p.emoji,
    bio: p.bio,
    speaking_style: p.speaking_style,
    core_values: p.core_values ?? [],
    known_biases: p.known_biases ?? [],
    topics_of_expertise: p.topics_of_expertise ?? [],
    model_override: p.model_override ?? null,
    enabled: p.enabled !== false,
    source_feeds: (p.source_feeds ?? []).map((f) => {
      const out: Record<string, unknown> = { type: f.type };
      if (f.query) out.query = f.query;
      if (f.route) out.route = f.route;
      if (f.handle) out.handle = f.handle;
      if (f.channel_id) out.channel_id = f.channel_id;
      if (f.url) out.url = f.url;
      if (f.label) out.label = f.label;
      if (f.enabled === false) out.enabled = false;
      return out;
    }),
  };
  return stringifyYaml(ordered, { lineWidth: 100 });
}

/** Insert any persona YAML from /personas that is not in the DB yet. */
export async function syncSeedPersonas(
  ctx: Ctx,
  opts: { force?: boolean } = {},
): Promise<{ inserted: string[]; updated: string[]; errors: { id: string; error: string }[] }> {
  const inserted: string[] = [];
  const updated: string[] = [];
  const errors: { id: string; error: string }[] = [];

  for (const [fileId, yaml] of Object.entries(SEED_PERSONAS)) {
    try {
      const parsed = parsePersonaYaml(yaml, fileId);
      const existing = await getPersona(ctx, parsed.id);
      if (existing && !opts.force) continue;
      await upsertPersona(ctx, parsed, yaml, 'seed');
      await ensureSources(ctx, { ...(existing ?? parsed), ...parsed } as PersonaRow);
      (existing ? updated : inserted).push(parsed.id);
    } catch (e) {
      errors.push({ id: fileId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { inserted, updated, errors };
}

export function seedPersonaIds(): string[] {
  return Object.keys(SEED_PERSONAS);
}
