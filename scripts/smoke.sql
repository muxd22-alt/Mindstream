-- Local smoke test (not a migration). Run with:
--   npx wrangler d1 execute council --local --file=scripts/smoke.sql

insert into personas (id, display_name, emoji, bio, speaking_style, core_values, known_biases,
                      topics_of_expertise, source_feeds, model_override, enabled, yaml, origin,
                      created_at, updated_at)
values ('elon', 'Elon Musk', '🚀', 'bio', 'style', '["speed"]', '["timelines"]', '["rockets"]',
        '[]', null, 1, 'id: elon', 'seed', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
on conflict (id) do nothing;

insert into documents (id, persona_id, source_id, url, url_hash, title, kind, lang, published_at,
                       fetched_at, content, content_chars, meta)
values ('doc1', 'elon', null, 'https://example.com/a', 'h1', 'Mortgage market in Saudi Arabia',
        'rss', 'en', '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z',
        'Saudi mortgage rules changed under SAMA and Sakani.', 52, '{}')
on conflict (persona_id, url_hash) do nothing;

insert into documents (id, persona_id, source_id, url, url_hash, title, kind, lang, published_at,
                       fetched_at, content, content_chars, meta)
values ('doc1', 'elon', null, 'https://example.com/a', 'h1', 'duplicate', 'rss', 'en', null,
        '2026-02-01T00:00:00.000Z', 'dup', 3, '{}')
on conflict (persona_id, url_hash) do nothing;

insert into chunks (id, document_id, persona_id, chunk_index, content, tokens, embedding, created_at)
values ('chk1', 'doc1', 'elon', 0, 'Saudi mortgage rules changed under SAMA and Sakani.', 10, '', '2026-02-01T00:00:00.000Z')
on conflict (document_id, chunk_index) do nothing;

-- FTS + bm25 (must be exactly this alias-free shape)
select c.id, d.title, bm25(chunks_fts) as rank
from chunks_fts
join chunks c on c.rowid = chunks_fts.rowid
join documents d on d.id = c.document_id
where chunks_fts match '"mortgage" OR "sama"' and c.persona_id = 'elon'
order by bm25(chunks_fts) asc
limit 5;

-- claim one job atomically
insert into runs (id, kind, status, dedupe_key, payload, state, created_at)
values ('run1', 'debate', 'queued', null, '{}', '{}', '2026-02-01T00:00:00.000Z');

update runs
set status = 'running', attempts = attempts + 1,
    started_at = '2026-02-01T00:00:00.000Z', lease_until = '2026-02-01T00:05:00.000Z'
where id = (
  select id from runs
  where (status = 'queued' or (status = 'running' and (lease_until is null or lease_until < '2026-02-01T00:01:00.000Z')))
    and (null is null or kind = null)
  order by created_at asc limit 1
)
returning id, status, attempts;

-- hashtag upsert twice
insert into hashtags (tag, debate_id, uses, created_at, last_used_at)
values ('#mortgage', null, 1, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')
on conflict (tag) do update set uses = hashtags.uses + 1, last_used_at = excluded.last_used_at;
insert into hashtags (tag, debate_id, uses, created_at, last_used_at)
values ('#mortgage', null, 1, '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')
on conflict (tag) do update set uses = hashtags.uses + 1, last_used_at = excluded.last_used_at;
select tag, uses from hashtags;

-- leave no junk job behind
delete from runs where id = 'run1';
delete from chunks where id = 'chk1';
delete from documents where id = 'doc1';
delete from hashtags where tag = '#mortgage';
