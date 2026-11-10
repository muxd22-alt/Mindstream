import type {
  Citation,
  Ctx,
  DebateRow,
  DebateState,
  JobRow,
  MessageRow,
  Persona,
  PersonaRow,
  ScribeResult,
} from '../types';
import { newId, nowIso, parseJson } from './client';

// ---------------------------------------------------------------- settings

export async function getSetting<T>(ctx: Ctx, key: string): Promise<T | null> {
  const row = await ctx.db.first<{ value: string }>('select value from settings where key = ?', key);
  return row ? parseJson<T | null>(row.value, null) : null;
}

export async function setSetting(ctx: Ctx, key: string, value: unknown): Promise<void> {
  await ctx.db.run(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
     on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
    nowIso(),
  );
}

export async function allSettings(ctx: Ctx): Promise<Record<string, unknown>> {
  const rows = await ctx.db.all<{ key: string; value: string }>('select key, value from settings');
  return Object.fromEntries(rows.map((r) => [r.key, parseJson(r.value, null as unknown)]));
}

// ---------------------------------------------------------------- personas

const PERSONA_COLS =
  'id, display_name, emoji, bio, speaking_style, core_values, known_biases, topics_of_expertise, source_feeds, model_override, enabled, yaml, origin, created_at, updated_at';

export async function listPersonas(ctx: Ctx, opts: { enabledOnly?: boolean } = {}): Promise<PersonaRow[]> {
  const sql = `select ${PERSONA_COLS} from personas ${opts.enabledOnly ? 'where enabled = 1' : ''} order by created_at asc`;
  const rows = await ctx.db.all<Record<string, unknown>>(sql);
  return rows.map(mapPersona);
}

export async function getPersona(ctx: Ctx, id: string): Promise<PersonaRow | null> {
  const row = await ctx.db.first<Record<string, unknown>>(`select ${PERSONA_COLS} from personas where id = ?`, id);
  return row ? mapPersona(row) : null;
}

export async function getPersonas(ctx: Ctx, ids: string[]): Promise<PersonaRow[]> {
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  const rows = await ctx.db.all<Record<string, unknown>>(
    `select ${PERSONA_COLS} from personas where id in (${marks})`,
    ...ids,
  );
  const order = new Map(ids.map((id, i) => [id, i]));
  return rows.map(mapPersona).sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
}

export async function upsertPersona(ctx: Ctx, persona: Persona, yaml: string, origin: string): Promise<PersonaRow> {
  const now = nowIso();
  await ctx.db.run(
    `insert into personas
      (id, display_name, emoji, bio, speaking_style, core_values, known_biases,
       topics_of_expertise, source_feeds, model_override, enabled, yaml, origin, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     on conflict (id) do update set
       display_name = excluded.display_name, emoji = excluded.emoji, bio = excluded.bio,
       speaking_style = excluded.speaking_style, core_values = excluded.core_values,
       known_biases = excluded.known_biases, topics_of_expertise = excluded.topics_of_expertise,
       source_feeds = excluded.source_feeds, model_override = excluded.model_override,
       enabled = excluded.enabled, yaml = excluded.yaml, origin = excluded.origin,
       updated_at = excluded.updated_at`,
    persona.id,
    persona.display_name,
    persona.emoji || '🗣',
    persona.bio,
    persona.speaking_style,
    JSON.stringify(persona.core_values ?? []),
    JSON.stringify(persona.known_biases ?? []),
    JSON.stringify(persona.topics_of_expertise ?? []),
    JSON.stringify(persona.source_feeds ?? []),
    persona.model_override ?? null,
    persona.enabled === false ? 0 : 1,
    yaml,
    origin,
    now,
    now,
  );
  const saved = await getPersona(ctx, persona.id);
  if (!saved) throw new Error(`Persona ${persona.id} was not saved`);
  return saved;
}

export async function setPersonaEnabled(ctx: Ctx, id: string, enabled: boolean): Promise<void> {
  await ctx.db.run('update personas set enabled = ?, updated_at = ? where id = ?', enabled ? 1 : 0, nowIso(), id);
}

export async function deletePersona(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.batch([
    { sql: 'delete from persona_drafts where persona_id = ?', values: [id] },
    { sql: 'delete from personas where id = ?', values: [id] },
  ]);
}

function mapPersona(r: Record<string, unknown>): PersonaRow {
  return {
    id: String(r.id),
    display_name: String(r.display_name ?? ''),
    emoji: String(r.emoji ?? '🗣'),
    bio: String(r.bio ?? ''),
    speaking_style: String(r.speaking_style ?? ''),
    core_values: parseJson<string[]>(r.core_values, []),
    known_biases: parseJson<string[]>(r.known_biases, []),
    topics_of_expertise: parseJson<string[]>(r.topics_of_expertise, []),
    source_feeds: parseJson<Persona['source_feeds']>(r.source_feeds, []),
    model_override: (r.model_override as string | null) ?? null,
    enabled: Number(r.enabled ?? 1) === 1,
    yaml: String(r.yaml ?? ''),
    origin: String(r.origin ?? 'seed'),
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
  };
}

// ---------------------------------------------------------------- sources

export async function ensureSources(ctx: Ctx, persona: PersonaRow): Promise<void> {
  const feeds = persona.source_feeds ?? [];
  if (!feeds.length) return;
  const now = nowIso();
  await ctx.db.batch(
    feeds.map((f) => ({
      sql: `insert into sources (id, persona_id, kind, url, query, label, enabled, created_at)
            values (?,?,?,?,?,?,?,?)
            on conflict (persona_id, kind, label) do nothing`,
      values: [
        newId('src'),
        persona.id,
        f.type,
        f.url ?? null,
        f.query ?? null,
        f.label ?? f.type,
        f.enabled === false ? 0 : 1,
        now,
      ],
    })),
  );
}

export interface SourceRow {
  id: string;
  persona_id: string;
  kind: string;
  url: string | null;
  query: string | null;
  label: string;
}

export async function listSources(ctx: Ctx, personaId?: string): Promise<SourceRow[]> {
  const sql = personaId
    ? 'select id, persona_id, kind, url, query, label from sources where enabled = 1 and persona_id = ?'
    : 'select id, persona_id, kind, url, query, label from sources where enabled = 1';
  return ctx.db.all<SourceRow>(sql, ...(personaId ? [personaId] : []));
}

export async function touchSource(ctx: Ctx, id: string, status: string): Promise<void> {
  await ctx.db.run(
    'update sources set last_run_at = ?, last_status = ? where id = ?',
    nowIso(),
    status.slice(0, 300),
    id,
  );
}

/** Used by /dig: create an ad-hoc source row for a one-off query. */
export async function ensureAdHocSource(
  ctx: Ctx,
  personaId: string,
  label: string,
  query: string,
): Promise<string> {
  const existing = await ctx.db.first<{ id: string }>(
    'select id from sources where persona_id = ? and kind = ? and label = ?',
    personaId,
    'googlenews',
    label,
  );
  if (existing) return existing.id;
  const id = newId('src');
  await ctx.db.run(
    'insert into sources (id, persona_id, kind, url, query, label, enabled, created_at) values (?,?,?,?,?,?,?,?)',
    id,
    personaId,
    'googlenews',
    null,
    query,
    label,
    1,
    nowIso(),
  );
  return id;
}

// ---------------------------------------------------------------- documents

export interface NewDocument {
  persona_id: string;
  source_id: string | null;
  url: string;
  url_hash: string;
  title: string;
  kind: string;
  lang: string;
  published_at: string | null;
  content: string;
  content_chars: number;
  meta: Record<string, unknown>;
}

export async function existingHashes(ctx: Ctx, personaId: string, hashes: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < hashes.length; i += 100) {
    const slice = hashes.slice(i, i + 100);
    const marks = slice.map(() => '?').join(',');
    const rows = await ctx.db.all<{ url_hash: string }>(
      `select url_hash from documents where persona_id = ? and url_hash in (${marks})`,
      personaId,
      ...slice,
    );
    for (const r of rows) found.add(r.url_hash);
  }
  return found;
}

export async function insertDocuments(
  ctx: Ctx,
  docs: NewDocument[],
): Promise<{ id: string; url: string; title: string; url_hash: string }[]> {
  if (!docs.length) return [];
  const cols = 13;
  const marks = docs.map(() => `(${Array.from({ length: cols }, () => '?').join(',')})`).join(',');
  const fetched = nowIso();
  const values = docs.flatMap((d) => [
    newId('doc'),
    d.persona_id,
    d.source_id,
    d.url,
    d.url_hash,
    d.title,
    d.kind,
    d.lang,
    d.published_at,
    fetched,
    d.content,
    d.content_chars,
    JSON.stringify(d.meta ?? {}),
  ]);
  return ctx.db.all<{ id: string; url: string; title: string; url_hash: string }>(
    `insert into documents
      (id, persona_id, source_id, url, url_hash, title, kind, lang, published_at, fetched_at,
       content, content_chars, meta)
     values ${marks}
     on conflict (persona_id, url_hash) do nothing
     returning id, url, title, url_hash`,
    ...values,
  );
}

export interface NewChunk {
  document_id: string;
  persona_id: string;
  chunk_index: number;
  content: string;
  tokens: number;
  embedding: string;
}

export async function insertChunks(ctx: Ctx, chunks: NewChunk[]): Promise<void> {
  const now = nowIso();
  for (let i = 0; i < chunks.length; i += 40) {
    const slice = chunks.slice(i, i + 40);
    const marks = slice.map(() => '(?,?,?,?,?,?,?,?)').join(',');
    await ctx.db.run(
      `insert into chunks (id, document_id, persona_id, chunk_index, content, tokens, embedding, created_at)
       values ${marks}
       on conflict (document_id, chunk_index) do nothing`,
      ...slice.flatMap((c) => [
        newId('chk'),
        c.document_id,
        c.persona_id,
        c.chunk_index,
        c.content,
        c.tokens,
        c.embedding,
        now,
      ]),
    );
  }
}

export async function listDocuments(
  ctx: Ctx,
  opts: { personaId?: string; since?: string; limit?: number; offset?: number } = {},
) {
  const where: string[] = [];
  const values: unknown[] = [];
  if (opts.personaId) {
    where.push('persona_id = ?');
    values.push(opts.personaId);
  }
  if (opts.since) {
    where.push('coalesce(published_at, fetched_at) >= ?');
    values.push(opts.since);
  }
  const sql = `select id, persona_id, title, url, kind, lang, published_at, fetched_at, content_chars
               from documents ${where.length ? `where ${where.join(' and ')}` : ''}
               order by fetched_at desc limit ? offset ?`;
  return ctx.db.all(
    sql,
    ...values,
    Math.min(opts.limit ?? 50, 200),
    opts.offset ?? 0,
  );
}

export async function countDocuments(ctx: Ctx, personaId?: string): Promise<number> {
  const row = personaId
    ? await ctx.db.first<{ c: number }>('select count(*) as c from documents where persona_id = ?', personaId)
    : await ctx.db.first<{ c: number }>('select count(*) as c from documents');
  return Number(row?.c ?? 0);
}

export async function countBeliefs(ctx: Ctx, personaId?: string): Promise<number> {
  const row = personaId
    ? await ctx.db.first<{ c: number }>(
        'select count(*) as c from beliefs where persona_id = ? and superseded_at is null',
        personaId,
      )
    : await ctx.db.first<{ c: number }>('select count(*) as c from beliefs where superseded_at is null');
  return Number(row?.c ?? 0);
}

export async function getDocument(ctx: Ctx, id: string) {
  return ctx.db.first<Record<string, unknown>>('select * from documents where id = ?', id);
}

export async function getChunksForDocument(ctx: Ctx, documentId: string) {
  return ctx.db.all<{ id: string; content: string; chunk_index: number }>(
    'select id, content, chunk_index from chunks where document_id = ? order by chunk_index asc',
    documentId,
  );
}

// ---------------------------------------------------------------- beliefs

export interface BeliefInput {
  persona_id: string;
  topic: string;
  topic_key: string;
  stance: string;
  quote_or_paraphrase: string;
  is_quote: boolean;
  confidence: number;
  stated_on: string | null;
  source_id: string | null;
  source_url: string | null;
  source_title: string | null;
}

export interface BeliefRow {
  id: string;
  persona_id: string;
  topic: string;
  topic_key: string;
  stance: string;
  quote_or_paraphrase: string;
  is_quote: boolean;
  confidence: number;
  stated_on: string | null;
  source_id: string | null;
  source_url: string | null;
  source_title: string | null;
  embedding: string;
  created_at: string;
  superseded_at: string | null;
}

export async function liveBeliefs(ctx: Ctx, personaId: string, topicKey?: string): Promise<BeliefRow[]> {
  const rows = await ctx.db.all<Record<string, unknown>>(
    `select * from beliefs where persona_id = ? and superseded_at is null ${topicKey ? 'and topic_key = ?' : ''}
     order by created_at desc`,
    personaId,
    ...(topicKey ? [topicKey] : []),
  );
  return rows.map(mapBelief);
}

export async function allLiveBeliefsWithEmbeddings(ctx: Ctx, personaId: string): Promise<BeliefRow[]> {
  return liveBeliefs(ctx, personaId);
}

export async function allBeliefs(
  ctx: Ctx,
  personaId: string,
  opts: { topic?: string; limit?: number } = {},
): Promise<BeliefRow[]> {
  const rows = await ctx.db.all<Record<string, unknown>>(
    `select * from beliefs where persona_id = ? ${opts.topic ? 'and topic_key = ?' : ''}
     order by created_at desc limit ?`,
    personaId,
    ...(opts.topic ? [opts.topic] : []),
    Math.min(opts.limit ?? 300, 500),
  );
  return rows.map(mapBelief);
}

function mapBelief(r: Record<string, unknown>): BeliefRow {
  return {
    id: String(r.id),
    persona_id: String(r.persona_id),
    topic: String(r.topic ?? ''),
    topic_key: String(r.topic_key ?? ''),
    stance: String(r.stance ?? ''),
    quote_or_paraphrase: String(r.quote_or_paraphrase ?? ''),
    is_quote: Number(r.is_quote ?? 0) === 1,
    confidence: Number(r.confidence ?? 0.5),
    stated_on: (r.stated_on as string | null) ?? null,
    source_id: (r.source_id as string | null) ?? null,
    source_url: (r.source_url as string | null) ?? null,
    source_title: (r.source_title as string | null) ?? null,
    embedding: String(r.embedding ?? ''),
    created_at: String(r.created_at ?? ''),
    superseded_at: (r.superseded_at as string | null) ?? null,
  };
}

export async function insertBelief(
  ctx: Ctx,
  belief: BeliefInput,
  embedding: string,
): Promise<string> {
  const id = newId('blf');
  const now = nowIso();
  await ctx.db.batch([
    {
      sql: `insert into beliefs
        (id, persona_id, topic, topic_key, stance, quote_or_paraphrase, is_quote, confidence,
         stated_on, source_id, source_url, source_title, embedding, created_at)
        values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      values: [
        id,
        belief.persona_id,
        belief.topic,
        belief.topic_key,
        belief.stance,
        belief.quote_or_paraphrase,
        belief.is_quote ? 1 : 0,
        belief.confidence,
        belief.stated_on,
        belief.source_id,
        belief.source_url,
        belief.source_title,
        embedding,
        now,
      ],
    },
    {
      sql: `update beliefs set superseded_at = ?
            where persona_id = ? and topic_key = ? and superseded_at is null and id <> ?`,
      values: [now, belief.persona_id, belief.topic_key, id],
    },
  ]);
  return id;
}

export async function beliefsSince(ctx: Ctx, sinceIso: string) {
  return ctx.db.all<{
    id: string;
    persona_id: string;
    topic: string;
    stance: string;
    source_url: string | null;
    source_title: string | null;
    created_at: string;
    superseded_at: string | null;
  }>(
    `select id, persona_id, topic, stance, source_url, source_title, created_at, superseded_at
     from beliefs where created_at >= ? order by created_at desc limit 80`,
    sinceIso,
  );
}

// ---------------------------------------------------------------- debates

const DEBATE_COLS =
  'id, chat_id, user_id, question, lang, mode, persona_ids, thread_key, status, stage, state, scribe, hashtags, model, created_at, finished_at';

export async function createDebate(
  ctx: Ctx,
  input: {
    chat_id: number | null;
    user_id: number | null;
    question: string;
    lang: 'en' | 'ar';
    mode: 'council' | 'chat' | 'dig' | 'chat_thread';
    persona_ids: string[];
    thread_key?: string | null;
  },
): Promise<DebateRow> {
  const id = newId('dbt');
  await ctx.db.run(
    `insert into debates (id, chat_id, user_id, question, lang, mode, persona_ids, thread_key, status, stage, state, created_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    input.chat_id,
    input.user_id,
    input.question,
    input.lang,
    input.mode,
    JSON.stringify(input.persona_ids),
    input.thread_key ?? null,
    'running',
    'round1',
    '{}',
    nowIso(),
  );
  const debate = await getDebate(ctx, id);
  if (!debate) throw new Error('Debate was not created');
  return debate;
}

export async function getDebate(ctx: Ctx, id: string): Promise<DebateRow | null> {
  const row = await ctx.db.first<Record<string, unknown>>(`select ${DEBATE_COLS} from debates where id = ?`, id);
  return row ? mapDebate(row) : null;
}

export async function updateDebate(
  ctx: Ctx,
  id: string,
  patch: Partial<{
    status: string;
    stage: string;
    state: DebateState;
    scribe: ScribeResult | null;
    hashtags: string[];
    model: string;
    finished_at: string | null;
  }>,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.status !== undefined) {
    sets.push('status = ?');
    values.push(patch.status);
  }
  if (patch.stage !== undefined) {
    sets.push('stage = ?');
    values.push(patch.stage);
  }
  if (patch.state !== undefined) {
    sets.push('state = ?');
    values.push(JSON.stringify(patch.state));
  }
  if (patch.scribe !== undefined) {
    sets.push('scribe = ?');
    values.push(patch.scribe ? JSON.stringify(patch.scribe) : null);
  }
  if (patch.hashtags !== undefined) {
    sets.push('hashtags = ?');
    values.push(JSON.stringify(patch.hashtags));
  }
  if (patch.model !== undefined) {
    sets.push('model = ?');
    values.push(patch.model);
  }
  if (patch.finished_at !== undefined) {
    sets.push('finished_at = ?');
    values.push(patch.finished_at);
  }
  if (!sets.length) return;
  await ctx.db.run(`update debates set ${sets.join(', ')} where id = ?`, ...values, id);
}

function mapDebate(r: Record<string, unknown>): DebateRow {
  return {
    id: String(r.id),
    chat_id: r.chat_id == null ? null : Number(r.chat_id),
    user_id: r.user_id == null ? null : Number(r.user_id),
    question: String(r.question ?? ''),
    lang: (r.lang === 'ar' ? 'ar' : 'en') as 'ar' | 'en',
    mode: String(r.mode ?? 'council') as DebateRow['mode'],
    persona_ids: parseJson<string[]>(r.persona_ids, []),
    thread_key: (r.thread_key as string | null) ?? null,
    status: String(r.status ?? 'open') as DebateRow['status'],
    stage: String(r.stage ?? 'round1'),
    state: parseJson<DebateState>(r.state, {}),
    scribe: parseJson<ScribeResult | null>(r.scribe, null),
    hashtags: parseJson<string[]>(r.hashtags, []),
    model: (r.model as string | null) ?? null,
    created_at: String(r.created_at ?? ''),
    finished_at: (r.finished_at as string | null) ?? null,
  };
}

export async function listDebates(
  ctx: Ctx,
  opts: { limit?: number; chatId?: number } = {},
): Promise<DebateRow[]> {
  const rows = await ctx.db.all<Record<string, unknown>>(
    `select ${DEBATE_COLS} from debates ${opts.chatId ? 'where chat_id = ?' : ''}
     order by created_at desc limit ?`,
    ...(opts.chatId ? [opts.chatId] : []),
    Math.min(opts.limit ?? 20, 100),
  );
  return rows.map(mapDebate);
}

export async function findOpenThread(ctx: Ctx, threadKey: string): Promise<DebateRow | null> {
  const row = await ctx.db.first<Record<string, unknown>>(
    `select ${DEBATE_COLS} from debates where thread_key = ? and status = 'open'
     order by created_at desc limit 1`,
    threadKey,
  );
  return row ? mapDebate(row) : null;
}

export async function addMessage(
  ctx: Ctx,
  m: {
    debate_id: string;
    persona_id?: string | null;
    round: number;
    role: MessageRow['role'];
    answer?: string | null;
    body: string;
    citations?: Citation[];
    inference?: boolean;
    model?: string | null;
    telegram_message_id?: number | null;
  },
): Promise<MessageRow> {
  const id = newId('msg');
  const now = nowIso();
  await ctx.db.run(
    `insert into messages (id, debate_id, persona_id, round, role, answer, body, citations, inference, model, telegram_message_id, created_at)
     values (?,?,?,?,?,?,?,?,?,?,?,?)`,
    id,
    m.debate_id,
    m.persona_id ?? null,
    m.round,
    m.role,
    m.answer ?? null,
    m.body,
    JSON.stringify(m.citations ?? []),
    m.inference ? 1 : 0,
    m.model ?? null,
    m.telegram_message_id ?? null,
    now,
  );
  return {
    id,
    debate_id: m.debate_id,
    persona_id: m.persona_id ?? null,
    round: m.round,
    role: m.role,
    answer: (m.answer as MessageRow['answer']) ?? null,
    body: m.body,
    citations: m.citations ?? [],
    inference: !!m.inference,
    model: m.model ?? null,
    created_at: now,
  };
}

export async function listMessages(ctx: Ctx, debateId: string): Promise<MessageRow[]> {
  const rows = await ctx.db.all<Record<string, unknown>>(
    'select * from messages where debate_id = ? order by created_at asc',
    debateId,
  );
  return rows.map(mapMessage);
}

export async function recentMessagesForThread(ctx: Ctx, debateId: string, limit = 12): Promise<MessageRow[]> {
  const rows = await ctx.db.all<Record<string, unknown>>(
    'select * from messages where debate_id = ? order by created_at desc limit ?',
    debateId,
    limit,
  );
  return rows.reverse().map(mapMessage);
}

function mapMessage(r: Record<string, unknown>): MessageRow {
  return {
    id: String(r.id),
    debate_id: String(r.debate_id),
    persona_id: (r.persona_id as string | null) ?? null,
    round: Number(r.round ?? 1),
    role: String(r.role ?? 'persona') as MessageRow['role'],
    answer: (r.answer as MessageRow['answer']) ?? null,
    body: String(r.body ?? ''),
    citations: parseJson<Citation[]>(r.citations, []),
    inference: Number(r.inference ?? 0) === 1,
    model: (r.model as string | null) ?? null,
    created_at: String(r.created_at ?? ''),
  };
}

// ---------------------------------------------------------------- hashtags

export async function recordHashtags(ctx: Ctx, tags: string[], debateId: string | null): Promise<void> {
  if (!tags.length) return;
  const now = nowIso();
  await ctx.db.batch(
    tags.map((tag) => ({
      sql: `insert into hashtags (tag, debate_id, uses, created_at, last_used_at) values (?,?,1,?,?)
            on conflict (tag) do update set
              uses = hashtags.uses + 1,
              last_used_at = excluded.last_used_at,
              debate_id = coalesce(excluded.debate_id, hashtags.debate_id)`,
      values: [tag, debateId, now, now],
    })),
  );
}

export async function listHashtags(ctx: Ctx, limit = 40) {
  return ctx.db.all<{ tag: string; uses: number; debate_id: string | null; last_used_at: string }>(
    'select tag, uses, debate_id, last_used_at from hashtags order by last_used_at desc limit ?',
    Math.min(limit, 100),
  );
}

// ---------------------------------------------------------------- runs / jobs

export async function enqueueRun(
  ctx: Ctx,
  kind: string,
  payload: Record<string, unknown>,
  dedupeKey?: string,
): Promise<JobRow> {
  if (dedupeKey) {
    const existing = await ctx.db.first<Record<string, unknown>>(
      `select * from runs where dedupe_key = ? and status in ('queued','running') order by created_at desc limit 1`,
      dedupeKey,
    );
    if (existing) return mapJob(existing);
  }
  const id = newId('run');
  await ctx.db.run(
    `insert into runs (id, kind, status, dedupe_key, payload, state, created_at) values (?,?,?,?,?,?,?)`,
    id,
    kind,
    'queued',
    dedupeKey ?? null,
    JSON.stringify(payload),
    '{}',
    nowIso(),
  );
  const row = await ctx.db.first<Record<string, unknown>>('select * from runs where id = ?', id);
  return mapJob(row!);
}

export async function claimRunById(ctx: Ctx, id: string): Promise<JobRow | null> {
  const now = nowIso();
  const lease = new Date(Date.now() + 5 * 60_000).toISOString();
  const row = await ctx.db.first<Record<string, unknown>>(
    `update runs
     set status = 'running', attempts = attempts + 1,
         started_at = coalesce(started_at, ?), lease_until = ?
     where id = ? and (status = 'queued' or (status = 'running' and (lease_until is null or lease_until < ?)))
     returning *`,
    now,
    lease,
    id,
    now,
  );
  return row ? mapJob(row) : null;
}

export async function claimNextRun(ctx: Ctx, kind?: string, limit = 2): Promise<JobRow[]> {
  const out: JobRow[] = [];
  for (let i = 0; i < limit; i++) {
    const now = nowIso();
    const lease = new Date(Date.now() + 5 * 60_000).toISOString();
    const row = await ctx.db.first<Record<string, unknown>>(
      `update runs
       set status = 'running', attempts = attempts + 1,
           started_at = coalesce(started_at, ?), lease_until = ?
       where id = (
         select id from runs
         where (status = 'queued' or (status = 'running' and (lease_until is null or lease_until < ?)))
           and (? is null or kind = ?)
         order by created_at asc limit 1
       )
       returning *`,
      now,
      lease,
      now,
      kind ?? null,
      kind ?? null,
    );
    if (!row) break;
    out.push(mapJob(row));
  }
  return out;
}

export async function finishRun(
  ctx: Ctx,
  id: string,
  opts: {
    status: 'done' | 'error' | 'queued';
    result?: unknown;
    error?: string;
    model?: string | null;
    state?: Record<string, unknown>;
  },
): Promise<void> {
  await ctx.db.run(
    `update runs set status = ?, result = ?, error = ?, model = coalesce(?, model), state = coalesce(?, state),
       lease_until = null, finished_at = ?
     where id = ?`,
    opts.status,
    opts.result === undefined ? null : JSON.stringify(opts.result),
    opts.error ?? null,
    opts.model ?? null,
    opts.state ? JSON.stringify(opts.state) : null,
    opts.status === 'queued' ? null : nowIso(),
    id,
  );
}

function mapJob(r: Record<string, unknown>): JobRow {
  return {
    id: String(r.id),
    kind: String(r.kind),
    status: String(r.status) as JobRow['status'],
    payload: parseJson(r.payload, {}),
    state: parseJson(r.state, {}),
    attempts: Number(r.attempts ?? 0),
    lease_until: (r.lease_until as string | null) ?? null,
    model: (r.model as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    result: parseJson(r.result, null),
    created_at: String(r.created_at ?? ''),
    started_at: (r.started_at as string | null) ?? null,
    finished_at: (r.finished_at as string | null) ?? null,
  };
}

export async function lastRun(ctx: Ctx, kind?: string): Promise<JobRow | null> {
  const row = await ctx.db.first<Record<string, unknown>>(
    `select * from runs ${kind ? 'where kind = ?' : ''} order by created_at desc limit 1`,
    ...(kind ? [kind] : []),
  );
  return row ? mapJob(row) : null;
}

export async function queuedCount(ctx: Ctx): Promise<number> {
  const row = await ctx.db.first<{ c: number }>(
    `select count(*) as c from runs where status = 'queued' or (status = 'running' and (lease_until is null or lease_until < ?))`,
    nowIso(),
  );
  return Number(row?.c ?? 0);
}

export async function lastSuccessfulModel(ctx: Ctx): Promise<string | null> {
  const row = await ctx.db.first<{ model: string }>(
    `select model from runs where model is not null order by started_at desc limit 1`,
  );
  return row?.model ?? null;
}

// ---------------------------------------------------------------- drafts

export async function saveDraft(
  ctx: Ctx,
  draft: { persona_id: string; yaml: string; payload: Record<string, unknown> },
): Promise<string> {
  const id = newId('drf');
  await ctx.db.run(
    'insert into persona_drafts (id, persona_id, yaml, payload, status, created_at) values (?,?,?,?,?,?)',
    id,
    draft.persona_id,
    draft.yaml,
    JSON.stringify(draft.payload),
    'pending',
    nowIso(),
  );
  return id;
}

export async function listDrafts(ctx: Ctx) {
  const rows = await ctx.db.all<{ id: string; persona_id: string; yaml: string; payload: string; created_at: string }>(
    `select id, persona_id, yaml, payload, created_at from persona_drafts where status = 'pending'
     order by created_at desc limit 20`,
  );
  return rows.map((r) => ({ ...r, payload: parseJson<Record<string, unknown>>(r.payload, {}) }));
}

export async function getDraft(ctx: Ctx, id: string) {
  const row = await ctx.db.first<{ id: string; persona_id: string; yaml: string; payload: string }>(
    'select id, persona_id, yaml, payload from persona_drafts where id = ?',
    id,
  );
  return row ? { ...row, payload: parseJson<Record<string, unknown>>(row.payload, {}) } : null;
}

export async function setDraftStatus(ctx: Ctx, id: string, status: 'approved' | 'rejected'): Promise<void> {
  await ctx.db.run('update persona_drafts set status = ? where id = ?', status, id);
}
