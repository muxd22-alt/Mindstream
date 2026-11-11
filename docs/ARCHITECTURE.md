# Council — how it works

## The five agents, in one chat

| Agent | When | What you see |
|---|---|---|
| 🔍 **Scout** | Before you speak, and every 6 hours | "Scout · 4 new sources across 3 personas" |
| 🚀 **Elon** · 🧭 **Sam** · 🔬 **Dario** | Round 1 | One model call returns three persona answers; Telegram posts each separately |
| Same three | Blind review + reply | Each reviewer ranks anonymous `V-A`/`V-B`/`V-C` views, then replies in character |
| 📝 **Scribe** | After every exchange and on `/end` | Unblinds aggregate ranks and writes the final synthesis, next steps and hashtags |
| 📓 **NotebookLM pack** | End of every debate | A `.md` file and `sources.txt` in the chat |

The thread is live: a follow-up message continues the same conversation for 90
minutes. `/new` starts over, `/end` closes with the final summary and pack.

```
You: /ask هل اشتري بيت بالتمويل العقاري؟
🔍 Scout     · 3 new sources across 3 personas
🚀 Elon      · NO        (cites 2 sources)
🧭 Sam       · DEPENDS   (cites 1 source)
🔬 Dario     · NO        (inference — nothing stored)
🚀 Elon      · blind rank + pushes back on View B
🧭 Sam       · blind rank + changes mind
🔬 Dario     · blind rank + adds a condition
📝 Scribe    · unblinds ranks · synthesis · 5 hashtags · next steps
📓 council-2026-11-10-a1b2c3.md + sources.txt
```

## Request budget

| Action | OpenRouter requests |
|---|---|
| `/ask` (default) | **3** — Round 1 + blind review/replies + Scribe |
| `/ask` (separate first opinions enabled) | **5** — 3 first opinions + blind review/replies + Scribe |
| Follow-up message | 2 — blind review/replies + Scribe |
| `/end` | 1 — Scribe |
| `/dig` | 2 — Round 1 + Scribe, no peer review or belief extraction |
| `/chat` | 1 |
| Scout run | 1 per persona (beliefs batched over up to 4 documents) |
| Pre-flight Scout refresh | **0** — headline feeds + embeddings only |
| Daily digest | 0 |

At **1,000 free-model requests/day** (the allowance an account gets after a
$10 top-up; 50/day without one) the default three-call flow allows at most ~333
debates/day before Scout and other projects use the shared key. Scout preflight
uses zero OpenRouter calls. `/status` reports the live remaining count.

`/status` shows the real remaining number from `GET /api/v1/key`
(`data.free_model_daily_requests`); nothing is hard-coded, so the same build
works on a 50/day account and a 1,000/day one. **Settings → separate first
opinions** raises the initial round from one call to three (5 total).

## Karpathy's LLM Council — what we adapted

The upstream project uses independent first responses, blind peer rankings of
anonymized answers, then a Chairman synthesis. Council adapts this as separate
persona messages, `V-A`/`V-B`/`V-C` aliases with author labels omitted from the
review views, deterministic average-rank/Borda aggregation, and the Scribe as the
final synthesizer. Each reviewer ranks every view; their own submission is
excluded from the aggregate. Source: [Karpathy's orchestration](https://github.com/karpathy/llm-council/blob/master/backend/council.py).

**Trade-off:** to preserve the original ≤4-request acceptance target, the
default Stage 2 asks one LLM request to produce separately framed reviews for
each persona. This is simulated blind prompt-level review, not independent-model
voting; the LLM could theoretically infer an author from writing style. The
optional separate-first-opinions setting costs two more calls, but does not add
one provider request per reviewer.

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
