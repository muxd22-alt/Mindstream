import type { Ctx, FetchedDoc, PersonaRow } from '../types';
import {
  beliefsSince,
  countBeliefs,
  countDocuments,
  ensureAdHocSource,
  ensureSources,
  existingHashes,
  getPersona,
  insertBelief,
  insertChunks,
  insertDocuments,
  lastRun,
  listPersonas,
  listSources,
  liveBeliefs,
  touchSource,
  type BeliefInput,
} from '../db/repo';
import { fetchFeed } from '../sources';
import { fetchGoogleNews } from '../sources/googlenews';
import { embedTexts, encodeVector } from '../ai/embed';
import { chunkText } from '../ai/chunk';
import { llm } from '../llm/openrouter';
import { asArray, extractJson, num, str } from '../llm/json';
import { renderPrompt } from '../prompts';
import { detectLang, limitWords, mapLimit, stanceChanged, topicKey, truncate, uniqueBy } from '../util/text';
import { normalizeUrl, sha256Hex } from '../util/hash';
import { getAllowedUserId } from '../telegram/guard';
import { sendMessage } from '../telegram/api';
import { escapeHtml } from '../util/text';

export interface PersonaScoutReport {
  personaId: string;
  feeds: number;
  fetched: number;
  duplicates: number;
  newDocs: number;
  chunks: number;
  newBeliefs: number;
  superseded: number;
  errors: string[];
}

export interface ScoutReport {
  trigger: string;
  startedAt: string;
  finishedAt: string;
  personas: PersonaScoutReport[];
  requests: number;
}

export interface ScoutOptions {
  personaIds?: string[];
  query?: string;
  trigger: 'cron' | 'manual' | 'dig';
  maxDocs?: number;
  /** /dig skips belief extraction to stay inside the free daily quota. */
  extractBeliefs?: boolean;
  /** Pre-flight refresh: headline feeds only, 2 docs per persona, no LLM. */
  quick?: boolean;
}

const BELIEF_DOCS_PER_CALL = 4;

/** Fetch → dedupe → chunk → embed → extract beliefs. Called by cron, /update and /dig. */
export async function runScout(ctx: Ctx, opts: ScoutOptions): Promise<ScoutReport> {
  const startedAt = new Date().toISOString();
  const personas = opts.personaIds?.length
    ? (await Promise.all(opts.personaIds.map((id) => getPersona(ctx, id)))).filter((p): p is PersonaRow => !!p)
    : await listPersonas(ctx, { enabledOnly: true });

  const reports: PersonaScoutReport[] = [];
  let requests = 0;

  for (const persona of personas) {
    const report: PersonaScoutReport = {
      personaId: persona.id,
      feeds: 0,
      fetched: 0,
      duplicates: 0,
      newDocs: 0,
      chunks: 0,
      newBeliefs: 0,
      superseded: 0,
      errors: [],
    };

    let phase = 'start';
    try {
      phase = 'sources';
      await ensureSources(ctx, persona);
      const stored = await listSources(ctx, persona.id);

      // Ad-hoc sources for /dig and /update <persona> "<keywords>"
      const extraDocs: { docs: FetchedDoc[]; label: string }[] = [];
      if (opts.query) {
        const label = `dig-${slug(opts.query)}`;
        await ensureAdHocSource(ctx, persona.id, label, opts.query);
        const result = await fetchGoogleNews({ type: 'googlenews', query: opts.query, label }, 8);
        extraDocs.push({ docs: result.docs, label });
        if (result.error) report.errors.push(`dig: ${result.error}`);
      }

      // Every stored source row is fetched, including ad-hoc ones from earlier digs.
      // In quick mode only headline feeds run, so a pre-flight refresh is fast.
      const feedsFromDb = (await listSources(ctx, persona.id)).filter(
        (s) => (s.kind !== 'googlenews' || s.query) && (!opts.quick || s.kind === 'googlenews'),
      );

      phase = 'fetch';
      const outcomes = await mapLimit(feedsFromDb, 4, async (source) => {
        const spec = (persona.source_feeds ?? []).find((f) => (f.label ?? f.type) === source.label);
        if (!spec) {
          // ad-hoc googlenews row (already fetched above for this run)
          if (source.kind === 'googlenews' && source.query) {
            if (opts.query && source.query === opts.query) return { docs: [], error: undefined };
            const r = await fetchGoogleNews({ type: 'googlenews', query: source.query, label: source.label }, 8);
            await touchSource(ctx, source.id, r.error ?? `ok ${r.docs.length}`);
            return { docs: r.docs, error: r.error };
          }
          return { docs: [], error: `unsupported ad-hoc source ${source.kind}` };
        }
        const r = await fetchFeed(ctx, persona, spec);
        await touchSource(ctx, source.id, r.error ?? `ok ${r.docs.length}`);
        return { docs: r.docs, error: r.error };
      });

      for (let i = 0; i < outcomes.length; i++) {
        const o = outcomes[i];
        report.feeds++;
        report.fetched += o.docs.length;
        if (o.error) report.errors.push(`${feedsFromDb[i]?.label ?? 'feed'}: ${o.error}`);
      }
      for (const extra of extraDocs) {
        report.fetched += extra.docs.length;
      }

      const all = uniqueBy(
        [...outcomes.flatMap((o) => o.docs), ...extraDocs.flatMap((e) => e.docs)].map((d) => ({
          ...d,
          url: normalizeUrl(d.url),
        })),
        (d) => d.url,
      );

      // Dedupe by URL hash against what is already stored.
      const withHash = await Promise.all(all.map(async (d) => ({ doc: d, hash: await sha256Hex(d.url) })));
      const seen = await existingHashes(ctx, persona.id, withHash.map((x) => x.hash));
      let fresh = withHash.filter((x) => !seen.has(x.hash));
      report.duplicates = withHash.length - fresh.length;

      const maxDocs = opts.quick
        ? 2
        : Math.min(opts.maxDocs ?? ctx.settings.max_docs_per_scout_run, 12);
      fresh = fresh.sort(byRecency).slice(0, maxDocs);

      if (!fresh.length) {
        reports.push(report);
        continue;
      }

      const sourceRowId = stored.find((s) => (persona.source_feeds ?? []).some((f) => (f.label ?? f.type) === s.label))?.id ?? null;
      const sourceIdByLabel = new Map(stored.map((s) => [s.label, s.id]));

      phase = 'insert-documents';
      const inserted = await insertDocuments(
        ctx,
        fresh.map(({ doc, hash }) => ({
          persona_id: persona.id,
          source_id: doc.feedLabel ? (sourceIdByLabel.get(doc.feedLabel) ?? sourceRowId) : sourceRowId,
          url: doc.url,
          url_hash: hash,
          title: truncate(doc.title || 'Untitled', 300),
          kind: doc.kind,
          lang: doc.lang ?? detectLang(doc.content),
          published_at: doc.publishedAt,
          content: truncate(doc.content, 60_000, ''),
          content_chars: doc.content.length,
          meta: doc.meta ?? {},
        })),
      );
      report.newDocs = inserted.length;
      if (!inserted.length) {
        reports.push(report);
        continue;
      }

      // Chunk + embed
      const idByHash = new Map(inserted.map((r) => [r.url_hash, r.id]));
      const pending: { documentId: string; title: string; url: string; published: string | null; chunks: { content: string; tokens: number }[] }[] = [];
      for (const { doc, hash } of fresh) {
        const documentId = idByHash.get(hash);
        if (!documentId) continue;
        const chunks = chunkText(doc.content).slice(0, ctx.settings.max_chunks_per_doc);
        if (!chunks.length) continue;
        pending.push({ documentId, title: doc.title, url: doc.url, published: doc.publishedAt, chunks });
      }

      if (pending.length) {
        const chunkRows: {
          document_id: string;
          persona_id: string;
          chunk_index: number;
          content: string;
          tokens: number;
          embedding: string;
        }[] = [];
        for (const p of pending) {
          p.chunks.forEach((c, idx) => {
            chunkRows.push({
              document_id: p.documentId,
              persona_id: persona.id,
              chunk_index: idx,
              content: c.content,
              tokens: c.tokens,
              embedding: '',
            });
          });
        }
        phase = 'embed-chunks';
        const vectors = await embedTexts(ctx, chunkRows.map((c) => c.content));
        chunkRows.forEach((row, i) => {
          row.embedding = encodeVector(vectors[i] ?? []);
        });
        phase = 'insert-chunks';
        await insertChunks(ctx, chunkRows);
        report.chunks = chunkRows.length;
      }

      // Belief extraction — one call per persona, batched over the newest docs.
      const toExtract = opts.extractBeliefs === false || opts.quick ? [] : pending.slice(0, BELIEF_DOCS_PER_CALL);
      if (toExtract.length) {
        const documents = toExtract
          .map((p, i) => `[${i}] ${p.title}${p.published ? ` (${p.published.slice(0, 10)})` : ''} — ${p.url}\n${truncate(p.chunks.map((c) => c.content).join('\n'), 3500)}`)
          .join('\n\n');

        phase = 'extract-beliefs';
        const rendered = renderPrompt('beliefs', {
          persona_name: persona.display_name,
          persona_id: persona.id,
          documents,
        });
        const res = await llm(ctx, {
          messages: [{ role: 'user', content: rendered }],
          label: 'beliefs',
          temperature: 0.2,
          maxTokens: 1500,
        });
        requests++;

        const parsed = extractJson<unknown>(res.text);
        const beliefs = asArray<Record<string, unknown>>(parsed).slice(0, 10);
        const embeddings = beliefs.length ? await embedTexts(ctx, beliefs.map((b) => sentenceForEmbedding(b))) : [];

        for (let i = 0; i < beliefs.length; i++) {
          const b = beliefs[i];
          const topic = str(b.topic).slice(0, 80) || 'general';
          const stance = limitWords(str(b.stance), 60);
          if (!stance) continue;
          const sourceIndex = Math.max(0, Math.min(toExtract.length - 1, Math.floor(num(b.source_index, 0))));
          const src = toExtract[sourceIndex];
          if (!src) continue;

          const key = topicKey(topic);
          const existing = await liveBeliefs(ctx, persona.id, key);
          const current = existing[0];
          if (current && !stanceChanged(current.stance, stance)) continue;

          const input: BeliefInput = {
            persona_id: persona.id,
            topic,
            topic_key: key,
            stance,
            quote_or_paraphrase: truncate(str(b.quote_or_paraphrase), 500),
            is_quote: b.is_quote === true,
            confidence: Math.min(1, Math.max(0, num(b.confidence, 0.5))),
            stated_on: normalizeDate(str(b.date)) ?? src.published?.slice(0, 10) ?? null,
            source_id: src.documentId,
            source_url: src.url,
            source_title: src.title,
          };
          phase = 'insert-belief';
          await insertBelief(ctx, input, encodeVector(embeddings[i] ?? []));
          report.newBeliefs++;
          if (current) report.superseded++;
        }
      }
    } catch (e) {
      report.errors.push(`[${phase}] ` + (e instanceof Error ? e.message.slice(0, 400) : String(e)));
    }

    reports.push(report);
  }

  return { trigger: opts.trigger, startedAt, finishedAt: new Date().toISOString(), personas: reports, requests };
}

function byRecency(a: { doc: FetchedDoc }, b: { doc: FetchedDoc }): number {
  const ta = a.doc.publishedAt ? Date.parse(a.doc.publishedAt) : 0;
  const tb = b.doc.publishedAt ? Date.parse(b.doc.publishedAt) : 0;
  return tb - ta;
}

function indexWithin(
  pending: { documentId: string; chunks: unknown[] }[],
  documentId: string,
  flatIndex: number,
): number {
  let offset = 0;
  for (const p of pending) {
    if (p.documentId === documentId) return flatIndex - offset;
    offset += p.chunks.length;
  }
  return 0;
}

function sentenceForEmbedding(b: Record<string, unknown>): string {
  return `${str(b.topic)}: ${str(b.stance)} ${str(b.quote_or_paraphrase)}`.trim();
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 30) || 'query';
}

function normalizeDate(s: string): string | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

// ---------------------------------------------------------------- daily digest

export interface DigestResult {
  sent: boolean;
  bullets: number;
  reason?: string;
}

/** 07:00 Asia/Riyadh — what changed per persona, max 3 bullets each. */
export async function runDailyDigest(ctx: Ctx, opts: { sinceHours?: number } = {}): Promise<DigestResult> {
  const userId = getAllowedUserId(ctx.env);
  if (!userId) return { sent: false, bullets: 0, reason: 'ALLOWED_TELEGRAM_USER_ID not set' };

  const since = new Date(Date.now() - (opts.sinceHours ?? 24) * 3600_000).toISOString();
  const changes = await beliefsSince(ctx, since);
  const personas = await listPersonas(ctx, { enabledOnly: true });

  const lines: string[] = [];
  const today = new Date().toISOString().slice(0, 10);
  lines.push(`🌅 <b>Council — what changed</b> · ${today}`);

  let bullets = 0;
  for (const persona of personas) {
    const items = changes.filter((c) => c.persona_id === persona.id).slice(0, 3);
    if (!items.length) continue;
    lines.push('');
    lines.push(`${persona.emoji} <b>${escapeHtml(persona.display_name)}</b>`);
    for (const item of items) {
      const changed = item.superseded_at ? ' · <i>updated</i>' : '';
      const link = item.source_url
        ? ` — <a href="${escapeHtml(item.source_url)}">${escapeHtml(item.source_title || 'source')}</a>`
        : '';
      lines.push(`• <b>${escapeHtml(item.topic)}</b>: ${escapeHtml(item.stance)}${changed}${link}`);
      bullets++;
    }
  }

  if (!bullets) {
    lines.push('');
    lines.push('<i>No new documented positions in the last 24h. Run /update to fetch now.</i>');
  } else {
    const totals = await Promise.all(personas.map(async (p) => `${p.emoji} ${await countDocuments(ctx, p.id)} docs`));
    lines.push('');
    lines.push(`<i>${totals.join(' · ')}</i>`);
  }

  const html = lines.join('\n');
  await sendMessage(ctx.env, userId, html);
  return { sent: true, bullets };
}

// ---------------------------------------------------------------- status helpers

export async function scoutStatus(ctx: Ctx) {
  const personas = await listPersonas(ctx);
  const last = await lastRun(ctx, 'scout');
  const perPersona = await Promise.all(
    personas.map(async (p) => ({
      id: p.id,
      name: p.display_name,
      emoji: p.emoji,
      enabled: p.enabled,
      documents: await countDocuments(ctx, p.id),
      beliefs: await countBeliefs(ctx, p.id),
    })),
  );
  return { last, perPersona };
}
