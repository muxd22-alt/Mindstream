# Council — acceptance tests

Run these after setup. Each maps to a hard requirement.

## 1. Arabic debate, correct shape

```
/ask هل اشتري بيت بالتمويل العقاري؟
```

Expect, in order:

1. `🔍 Scout · N new source(s)` — the pre-flight refresh, zero LLM calls.
2. Three persona messages, each labelled **simulated**, each `نعم / لا / يعتمد`
   with a reason and either a citation link or an explicit inference note.
3. A rebuttal round where they name each other.
4. `📝 Scribe` with a verdict list, agreement/disagreement lines, 3 next steps,
   5 hashtags and a disclaimer (money question).
5. A `.md` file + `sources.txt` in the chat.

Check the request count:

```bash
npx wrangler d1 execute council --remote --command \
  "select kind, model, attempts, json_extract(result,'$.requests') requests from runs where kind in ('debate','user_turn') order by created_at desc limit 5"
```

Live mode is 5 requests (3 parallel + Round 2 + Scribe); batch mode is 3.

## 2. Scout twice: no duplicates, stance history

```
/update elon
/update elon
/beliefs elon
```

- The second run reports `duplicates > 0` and few or no new documents.
- When a source changes a stance, `/beliefs` shows the current line plus a
  struck-through older line with both dates.

SQL check:

```bash
npx wrangler d1 execute council --remote --command \
  "select persona_id, topic_key, count(*) n, sum(case when superseded_at is null then 1 else 0 end) live from beliefs group by 1,2 having n > 1"
```

## 3. Export → clone → import → it debates

```
/persona export elon
/persona clone elon elon_2020
/persona import          (send the exported .yaml back)
/personas
/chat elon_2020
```

`elon_2020` appears in `/personas` and answers in its own voice.

## 4. Strangers are ignored

Message the bot from another Telegram account: no reply, no debate, no row.
The Mini App URL also rejects their `initData` (HMAC + owner check).

## 5. First model 429 → next model answers

`/status` shows:

```
Model in use: <the model that actually answered>
Fallback chain: <ordered MODELS>
```

With a rate-limited first model you will see the second one in "Model in use".

## Automated logic tests

```bash
npm run selftest
```

Covers: persona YAML parsing/round-trip, chunking (Arabic), tolerant JSON,
citation filtering against retrieved refs, inference forcing, hashtag and
next-step normalisation, disclaimer fallback, Saudi safety lines, word cap,
vector codec + cosine, recency decay, URL dedupe, Telegram HTML escaping,
initData HMAC, message splitting.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Bot silent | Run **Deploy** and read the step that failed. `check-secrets.mjs` lists missing secrets. |
| "D1 binding DB is missing" | `D1_DATABASE_ID` variable unset, or `wrangler.toml` still has the placeholder. |
| `/status` quota "unknown" | OpenRouter did not report the field; the bot keeps working rather than guessing. |
| Scout finds nothing | Check `/sources` in the Mini App. A person with no `source_feeds` has nothing to fetch. |
| YouTube feed fails | Set `channel_id: UC…` instead of `handle`. |
| Transcripts skipped | YouTube blocks datacentre IPs sometimes; the workflow logs it and exits 0. |
| Mini App won't load | Open it from the bot's menu button; it needs Telegram `initData`. Check `PUBLIC_BASE_URL`. |
| Debate slow | Free models are slow; three parallel calls + one rebuttal + one summary is the floor. |
| Start over | **Backup D1**, delete the database, re-run Setup. |
