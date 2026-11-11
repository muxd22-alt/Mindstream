-- ============================================================
-- Council — Cloudflare D1 (SQLite) schema
-- Applied with:  npx wrangler d1 migrations apply council --remote
-- Or from the "Setup" GitHub Action. Safe to re-run.
-- ============================================================

-- ------------------------------------------------------------
-- personas
-- ------------------------------------------------------------
create table if not exists personas (
  id                  text primary key,
  display_name        text not null,
  emoji               text not null default '🗣',
  bio                 text not null default '',
  speaking_style      text not null default '',
  core_values         text not null default '[]',
  known_biases        text not null default '[]',
  topics_of_expertise text not null default '[]',
  source_feeds        text not null default '[]',
  model_override      text,
  enabled             integer not null default 1,
  yaml                text not null default '',
  origin              text not null default 'seed',
  created_at          text not null,
  updated_at          text not null
);

-- ------------------------------------------------------------
-- sources = feed definitions per persona
-- ------------------------------------------------------------
create table if not exists sources (
  id           text primary key,
  persona_id   text not null references personas(id) on delete cascade,
  kind         text not null,
  url          text,
  query        text,
  label        text not null default '',
  enabled      integer not null default 1,
  last_run_at  text,
  last_status  text,
  created_at   text not null,
  unique (persona_id, kind, label)
);
create index if not exists sources_persona_idx on sources (persona_id);

-- ------------------------------------------------------------
-- documents = fetched articles / transcripts / show notes
-- ------------------------------------------------------------
create table if not exists documents (
  id            text primary key,
  persona_id    text not null references personas(id) on delete cascade,
  source_id     text references sources(id) on delete set null,
  url           text not null,
  url_hash      text not null,
  title         text not null default '',
  kind          text not null default 'rss',
  lang          text not null default 'en',
  published_at  text,
  fetched_at    text not null,
  content       text not null default '',
  content_chars integer not null default 0,
  meta          text not null default '{}',
  unique (persona_id, url_hash)
);
create index if not exists documents_persona_published_idx
  on documents (persona_id, published_at desc);
create index if not exists documents_hash_idx on documents (url_hash);

-- ------------------------------------------------------------
-- chunks + FTS5 index (hybrid lexical prefilter, then cosine in JS)
-- embedding = base64 of Float32Array (1024 dims, bge-m3)
-- ------------------------------------------------------------
create table if not exists chunks (
  id          text primary key,
  document_id text not null references documents(id) on delete cascade,
  persona_id  text not null references personas(id) on delete cascade,
  chunk_index integer not null default 0,
  content     text not null,
  tokens      integer not null default 0,
  embedding   text not null default '',
  created_at  text not null,
  unique (document_id, chunk_index)
);
create index if not exists chunks_persona_idx on chunks (persona_id);

create virtual table if not exists chunks_fts using fts5(
  content,
  content='chunks',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

create trigger if not exists chunks_ai after insert on chunks begin
  insert into chunks_fts(rowid, content) values (new.rowid, new.content);
end;

create trigger if not exists chunks_ad after delete on chunks begin
  insert into chunks_fts(chunks_fts, rowid, content) values ('delete', old.rowid, old.content);
end;

create trigger if not exists chunks_au after update on chunks begin
  insert into chunks_fts(chunks_fts, rowid, content) values ('delete', old.rowid, old.content);
  insert into chunks_fts(rowid, content) values (new.rowid, new.content);
end;

-- ------------------------------------------------------------
-- beliefs = extracted stances + thought history (superseded_at)
-- ------------------------------------------------------------
create table if not exists beliefs (
  id                  text primary key,
  persona_id          text not null references personas(id) on delete cascade,
  topic               text not null,
  topic_key           text not null,
  stance              text not null,
  quote_or_paraphrase text not null default '',
  is_quote            integer not null default 0,
  confidence          real not null default 0.5,
  stated_on           text,
  source_id           text references documents(id) on delete set null,
  source_url          text,
  source_title        text,
  embedding           text not null default '',
  created_at          text not null,
  superseded_at       text
);
create index if not exists beliefs_persona_topic_idx
  on beliefs (persona_id, topic_key, created_at desc);
create index if not exists beliefs_live_idx on beliefs (persona_id, superseded_at);

-- ------------------------------------------------------------
-- debates + messages
-- ------------------------------------------------------------
create table if not exists debates (
  id          text primary key,
  chat_id     integer,
  user_id     integer,
  question    text not null,
  lang        text not null default 'en',
  mode        text not null default 'council',
  persona_ids text not null default '[]',
  thread_key  text,
  status      text not null default 'open',
  stage       text not null default 'round1',
  state       text not null default '{}',
  scribe      text,
  hashtags    text not null default '[]',
  model       text,
  created_at  text not null,
  finished_at text
);
create index if not exists debates_created_idx on debates (created_at desc);
create index if not exists debates_thread_idx on debates (thread_key, status);
create index if not exists debates_chat_idx on debates (chat_id, created_at desc);

create table if not exists messages (
  id                  text primary key,
  debate_id           text not null references debates(id) on delete cascade,
  persona_id          text,
  round               integer not null default 1,
  role                text not null default 'persona',
  answer              text,
  body                text not null default '',
  citations           text not null default '[]',
  inference           integer not null default 0,
  model               text,
  telegram_message_id integer,
  created_at          text not null
);
create index if not exists messages_debate_idx on messages (debate_id, round, created_at);

-- ------------------------------------------------------------
-- hashtags
-- ------------------------------------------------------------
create table if not exists hashtags (
  tag          text primary key,
  debate_id    text,
  uses         integer not null default 1,
  created_at   text not null,
  last_used_at text not null
);

-- ------------------------------------------------------------
-- runs = job queue + logs
-- ------------------------------------------------------------
create table if not exists runs (
  id          text primary key,
  kind        text not null,
  status      text not null default 'queued',
  dedupe_key  text,
  payload     text not null default '{}',
  state       text not null default '{}',
  attempts    integer not null default 0,
  lease_until text,
  model       text,
  error       text,
  result      text,
  created_at  text not null,
  started_at  text,
  finished_at text
);
create index if not exists runs_queue_idx on runs (status, created_at);
create index if not exists runs_kind_idx on runs (kind, created_at desc);
create index if not exists runs_dedupe_idx on runs (dedupe_key, status);

-- ------------------------------------------------------------
-- settings (key/value JSON)
-- ------------------------------------------------------------
create table if not exists settings (
  key        text primary key,
  value      text not null,
  updated_at text not null
);

-- ------------------------------------------------------------
-- persona drafts awaiting approval in the Mini App
-- ------------------------------------------------------------
create table if not exists persona_drafts (
  id         text primary key,
  persona_id text not null,
  yaml       text not null,
  payload    text not null default '{}',
  status     text not null default 'pending',
  created_at text not null
);

-- ------------------------------------------------------------
-- default settings
-- ------------------------------------------------------------
insert into settings (key, value, updated_at) values
  ('recency_half_life_days', '90', '2024-01-01T00:00:00.000Z'),
  ('rounds', '2', '2024-01-01T00:00:00.000Z'),
  ('persona_word_limit', '120', '2024-01-01T00:00:00.000Z'),
  ('language', '"auto"', '2024-01-01T00:00:00.000Z'),
  ('max_docs_per_scout_run', '6', '2024-01-01T00:00:00.000Z'),
  ('parallel_round1', 'false', '2024-01-01T00:00:00.000Z')
on conflict (key) do nothing;
