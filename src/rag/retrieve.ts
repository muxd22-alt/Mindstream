import type { Citation, Ctx, Persona, RetrievedBelief, RetrievedChunk } from '../types';
import { allLiveBeliefsWithEmbeddings } from '../db/repo';
import { cosine, decodeVector, embedOne, recencyWeight } from '../ai/embed';
import { tokens, uniqueBy } from '../util/text';

export interface PersonaContext {
  chunks: RetrievedChunk[];
  beliefs: RetrievedBelief[];
  /** True when we genuinely have nothing for this persona on this question. */
  empty: boolean;
}

const LEXICAL_LIMIT = 60;
const RECENCY_LIMIT = 40;
const MAX_PER_DOCUMENT = 2;

interface CandidateRow {
  id: string;
  document_id: string;
  embedding: string;
  title: string;
  url: string;
  published_at: string | null;
  fetched_at: string;
}

/**
 * Hybrid retrieval: FTS5 lexical prefilter + a recent pool, then exact cosine
 * ranking in JS, decayed by recency (half-life configurable).
 *
 * Content is fetched only for the winners, to keep CPU per invocation small.
 */
export async function retrieveForPersona(
  ctx: Ctx,
  personaId: string,
  question: string,
  opts: { chunks?: number; beliefs?: number; halfLifeDays?: number } = {},
): Promise<PersonaContext> {
  const wantChunks = opts.chunks ?? 8;
  const wantBeliefs = opts.beliefs ?? 5;
  const halfLife = opts.halfLifeDays ?? ctx.settings.recency_half_life_days;

  const queryVec = Float32Array.from(await embedOne(ctx, question));

  const [lexical, recent] = await Promise.all([
    lexicalCandidates(ctx, personaId, question),
    recentCandidates(ctx, personaId),
  ]);

  const pool = uniqueBy([...lexical, ...recent], (r) => r.id);
  const scored = pool
    .map((row) => {
      const sim = cosine(queryVec, decodeVector(row.embedding));
      const decay = recencyWeight(row.published_at ?? row.fetched_at, halfLife);
      return { row, similarity: sim, score: sim * (0.65 + 0.35 * decay) };
    })
    .filter((c) => c.similarity > 0.15)
    .sort((a, b) => b.score - a.score);

  const perDoc = new Map<string, number>();
  const winners: typeof scored = [];
  for (const c of scored) {
    const used = perDoc.get(c.row.document_id) ?? 0;
    if (used >= MAX_PER_DOCUMENT) continue;
    perDoc.set(c.row.document_id, used + 1);
    winners.push(c);
    if (winners.length >= wantChunks) break;
  }

  const contents = await chunkContents(ctx, winners.map((w) => w.row.id));
  const chunks: RetrievedChunk[] = winners.map((w) => ({
    chunk_id: w.row.id,
    document_id: w.row.document_id,
    content: contents.get(w.row.id) ?? '',
    title: w.row.title || 'Untitled',
    url: w.row.url,
    published_at: w.row.published_at,
    similarity: w.similarity,
    score: w.score,
  }));

  const beliefs = await retrieveBeliefs(ctx, personaId, queryVec, wantBeliefs, halfLife);

  return { chunks, beliefs, empty: chunks.length === 0 && beliefs.length === 0 };
}

async function chunkContents(ctx: Ctx, ids: string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map();
  const marks = ids.map(() => '?').join(',');
  const rows = await ctx.db.all<{ id: string; content: string }>(
    `select id, content from chunks where id in (${marks})`,
    ...ids,
  );
  return new Map(rows.map((r) => [r.id, r.content]));
}

async function lexicalCandidates(ctx: Ctx, personaId: string, question: string): Promise<CandidateRow[]> {
  const match = ftsQuery(question);
  if (!match) return [];
  try {
    return await ctx.db.all<CandidateRow>(
      `select c.id, c.document_id, c.embedding, d.title, d.url, d.published_at, d.fetched_at
       from chunks_fts
       join chunks c on c.rowid = chunks_fts.rowid
       join documents d on d.id = c.document_id
       where chunks_fts match ? and c.persona_id = ?
       order by bm25(chunks_fts) asc
       limit ?`,
      match,
      personaId,
      LEXICAL_LIMIT,
    );
  } catch {
    return [];
  }
}

async function recentCandidates(ctx: Ctx, personaId: string): Promise<CandidateRow[]> {
  return ctx.db.all<CandidateRow>(
    `select c.id, c.document_id, c.embedding, d.title, d.url, d.published_at, d.fetched_at
     from chunks c
     join documents d on d.id = c.document_id
     where c.persona_id = ?
     order by coalesce(d.published_at, d.fetched_at) desc
     limit ?`,
    personaId,
    RECENCY_LIMIT,
  );
}

async function retrieveBeliefs(
  ctx: Ctx,
  personaId: string,
  queryVec: Float32Array,
  want: number,
  halfLife: number,
): Promise<RetrievedBelief[]> {
  const beliefs = await allLiveBeliefsWithEmbeddings(ctx, personaId);
  return beliefs
    .map((b) => {
      const sim = cosine(queryVec, decodeVector(b.embedding));
      const decay = recencyWeight(b.stated_on ?? b.created_at, halfLife);
      return {
        belief_id: b.id,
        topic: b.topic,
        stance: b.stance,
        quote_or_paraphrase: b.quote_or_paraphrase,
        is_quote: b.is_quote,
        confidence: b.confidence,
        stated_on: b.stated_on,
        source_url: b.source_url,
        source_title: b.source_title,
        similarity: sim,
        score: sim * b.confidence * (0.6 + 0.4 * decay),
      };
    })
    .filter((b) => b.similarity > 0.22)
    .sort((a, b) => b.score - a.score)
    .slice(0, want);
}

/** FTS5 query: quoted terms OR'd together. Returns null when unusable. */
export function ftsQuery(question: string): string | null {
  const words = uniqueBy(
    tokens(question).filter((t) => t.length > 2),
    (t) => t,
  ).slice(0, 12);
  if (!words.length) return null;
  return words.map((w) => `"${w.replace(/"/g, '')}"`).join(' OR ');
}

// ---------------------------------------------------------------- prompt blocks

export interface PersonaBlock {
  text: string;
  refs: Map<string, Citation>;
}

/**
 * Builds the SOURCES / BELIEFS block for one persona plus a ref → citation map,
 * so we can validate whatever the model cites and drop anything invented.
 */
export function personaBlock(persona: Persona, ctxData: PersonaContext): PersonaBlock {
  const refs = new Map<string, Citation>();
  const lines: string[] = [];

  lines.push(`### ${persona.id} — ${persona.display_name} ${persona.emoji}`);
  lines.push(`STYLE: ${truncate(persona.speaking_style, 420)}`);
  if (persona.core_values.length) lines.push(`VALUES: ${persona.core_values.slice(0, 6).join('; ')}`);
  if (persona.known_biases.length) lines.push(`BIASES: ${persona.known_biases.slice(0, 5).join('; ')}`);
  if (persona.topics_of_expertise.length)
    lines.push(`EXPERTISE: ${persona.topics_of_expertise.slice(0, 8).join('; ')}`);

  if (ctxData.chunks.length) {
    lines.push('');
    lines.push('SOURCES:');
    ctxData.chunks.forEach((c, i) => {
      const ref = `S${i + 1}`;
      const date = c.published_at ? c.published_at.slice(0, 10) : null;
      refs.set(ref, { title: c.title, date, url: c.url, ref, snippet: truncate(c.content, 200) });
      lines.push(`[${ref}] ${c.title}${date ? ` (${date})` : ''} — ${c.url}`);
      lines.push(truncate(c.content, 700));
      lines.push('');
    });
  } else {
    lines.push('');
    lines.push('SOURCES: (none retrieved — you have no stored source on this question)');
  }

  if (ctxData.beliefs.length) {
    lines.push('RECORDED BELIEFS (current stances):');
    for (const b of ctxData.beliefs) {
      const date = b.stated_on ?? '';
      const src = b.source_url ? ` <${b.source_url}>` : '';
      const quote = b.is_quote ? ` QUOTE: "${truncate(b.quote_or_paraphrase, 220)}"` : '';
      lines.push(`- ${b.topic}: ${b.stance}${date ? ` (${date})` : ''}${src}${quote}`);
    }
    lines.push('');
  }

  return { text: lines.join('\n'), refs };
}

export function beliefsBlock(beliefs: RetrievedBelief[]): string {
  if (!beliefs.length) return '(no stored beliefs matched this question)';
  return beliefs
    .map((b) => {
      const date = b.stated_on ?? '';
      const src = b.source_url ? ` <${b.source_url}>` : '';
      return `- ${b.topic}: ${b.stance}${date ? ` (${date})` : ''}${src}`;
    })
    .join('\n');
}

export function sourcesBlock(chunks: RetrievedChunk[], citations: Citation[] = []): string {
  const all = [
    ...citations,
    ...chunks.map((c) => ({ title: c.title, date: c.published_at?.slice(0, 10) ?? null, url: c.url })),
  ];
  const unique = uniqueBy(all, (c) => c.url);
  if (!unique.length) return '(no sources)';
  return unique.map((c) => `- ${c.title}${c.date ? ` (${c.date})` : ''} — ${c.url}`).join('\n');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}
