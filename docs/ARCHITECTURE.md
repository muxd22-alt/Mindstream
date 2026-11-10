# Council — how it works

## The five agents, in one chat

| Agent | When | What you see |
|---|---|---|
| 🔍 **Scout** | Before you speak, and every 6 hours | "Scout · 4 new sources across 3 personas" |
| 🚀 **Elon** · 🧭 **Sam** · 🔬 **Dario** | Round 1, in parallel | Each answer lands as its own message, the moment it is written |
| Same three | Round 2 | They quote each other, agree, push back, or change their mind |
| 📝 **Scribe** | After every exchange and on `/end` | Verdict, agreements, disagreements, next steps, 5 hashtags |
| 📓 **NotebookLM pack** | End of every debate | A `.md` file and `sources.txt` in the chat |

The thread is live: a follow-up message continues the same conversation for 90
minutes. `/new` starts over, `/end` closes with the final summary and pack.

```
You: /ask هل اشتري بيت بالتمويل العقاري؟
🔍 Scout     · 3 new sources across 3 personas
🚀 Elon      · NO        (cites 2 sources)
🧭 Sam       · DEPENDS   (cites 1 source)
🔬 Dario     · NO        (inference — nothing stored)
🚀 Elon      · pushes back, names Sam's rate assumption
🧭 Sam       · changes mind, depends
🔬 Dario     · agrees with Sam's new condition
📝 Scribe    · verdict table · 5 hashtags · next steps
📓 council-2026-11-10-a1b2c3.md + sources.txt
```

## Request budget

| Action | OpenRouter requests |
|---|---|
| `/ask` (live mode, default) | **5** — 3 parallel Round 1 + Round 2 + Scribe |
| `/ask` (batch mode, setting off) | **3** — one Round 1 + Round 2 + Scribe |
| Follow-up message | 2 — replies + Scribe |
| `/end` | 1 — Scribe |
| `/dig` | 2 — Round 1 (parallel) + Scribe, no belief extraction |
| `/chat` | 1 |
| Scout run | 1 per persona (beliefs batched over up to 4 documents) |
| Pre-flight Scout refresh | **0** — headline feeds + embeddings only |
| Daily digest | 0 |

At ~50 free requests/day that is roughly 9 live debates/day with Scout still
running every 6 hours. `/status` shows the real remaining number from
`GET /api/v1/key`; nothing is hard-coded. Switch **Settings → Live mode → Off**
for the cheaper 3-request path.

## Why it survives the free tier

The webhook returns `200` immediately and writes a job row. A cron trigger every
minute drains the queue. Each debate stage checkpoints into `debates.state`
*after* the LLM call and *before* Telegram sends, and already-posted round-1
messages are skipped on retry. A killed invocation therefore resumes without
paying twice or double-posting.

Scout calls the Worker once per persona, keeping each invocation well under the
free-plan subrequest limit.

## Retrieval

1. Embed the question with `@cf/baai/bge-m3` (1024 dims, multilingual).
2. D1 FTS5 (`unicode61 remove_diacritics 2`) returns 60 lexical chunks for the
   persona; a second query returns the 40 most recent.
3. Cosine similarity is computed in the Worker over that pool only.
4. `score = similarity × (0.65 + 0.35 × 0.5^(age / half-life))`, half-life
   configurable (default 90 days).
5. Top 8 chunks (max 2 per document) + top 5 live beliefs become `S1…Sn` refs.
6. The model may only cite those refs. Unknown refs are dropped; zero surviving
   citations forces `inference: true`.

No vector database: embeddings are base64 Float32 in D1, so there is exactly one
datastore.

## Grounding pipeline

```
RSS / Google News / blog / YouTube / podcast / RSSHub
        │
        ▼  url_hash dedupe (per persona)
   documents ──► chunk (~800 tokens) ──► bge-m3 ──► chunks (+ FTS5)
        │
        ▼  one LLM call per persona, batched over ≤4 docs
   beliefs { topic, stance, confidence, date, source }
        │
        ├─ same topic + materially different stance
        │     → new row, old row gets superseded_at   (thought history)
        └─ same stance → skipped (no duplicate churn)
```

## Data model (`migrations/0001_init.sql`)

`personas` · `sources` (feed definitions) · `documents` · `chunks` (+ FTS5) ·
`beliefs` (with `superseded_at`) · `debates` · `messages` · `hashtags` ·
`runs` (job queue + logs) · `settings` · `persona_drafts`.

## Ground rules in code

| Rule | Enforcement |
|---|---|
| Every persona message is simulated | header tag + Mini App badge + pack header |
| No invented quotes | `is_quote` only for verbatim text; UI never presents paraphrases as quotes |
| A view claim needs a stored source | `resolveCitations()` against the retrieved set only |
| Empty knowledge → say so | empty context ⇒ `inference: true` with an explicit note |
| Reply in the user's language | `detectLang()` + prompt instruction |
| ≤120 words per persona per round | `limitWords()` truncates after the model returns |
| Money/health/legal footer | forced in `parseScribe()` even if the model omits it |
| Saudi context | SAR / SAMA / Sakani / Vision 2030 injected; no invented rates |
| Only the owner | `ALLOWED_TELEGRAM_USER_ID` on every update + `initData` HMAC |
| Free models only | `modelList()` strips non-`:free` ids unless explicitly allowed |

## Mini App

Served by the same Worker at `/app` (no separate Pages project, no CORS):

- **Debate** — live thread, citations, verdict chips, reply, another round,
  end & summarize, download `.md`.
- **Personas** — edit YAML, toggle, clone, import, download, belief timeline.
- **Sources** — documents per persona, date filter, feed list.
- **Hashtags** — one tap runs `/dig`.
- **Settings** — live mode, half-life, rounds, word limit, language, models.

Auth is Telegram `initData` HMAC + the owner id.
