# Council — add a new person

Council is a Telegram bot where five agents work in one chat:

```
🔍 Scout      refreshes each person from news, blogs, podcasts, YouTube before you speak
🗣  Personas   answer one by one, then read each other and reply
📝 Scribe     closes with a verdict, next steps and a NotebookLM .md pack
```

The three default people are Elon Musk, Sam Altman and Dario Amodei. **This page
is about adding another one.** Everything else is setup you do once — see
[docs/SETUP.md](docs/SETUP.md).

---

## The short version

1. Copy `personas/_template.yaml` to `personas/<id>.yaml`.
2. Fill in the person.
3. Commit it.
4. Run **Actions → Setup → Run workflow**, `mode: seed`.
5. `/update <id>` in Telegram, then ask something.

No code changes. No redeploy. A persona is a YAML file.

```bash
cp personas/_template.yaml personas/sarah_connor.yaml
# edit it, then:
git add personas/sarah_connor.yaml && git commit -m "persona: sarah_connor" && git push
```

Prefer to stay on the phone? Do it from Telegram:

```
/persona add Sarah Connor
```

Scout sweeps the news, drafts the YAML, and sends it to you. Open the Mini App →
**Personas → Drafts → Approve**. Done — it can debate immediately.

---

## What a person is made of

```yaml
id: elon
display_name: Elon Musk
emoji: "🚀"
bio: >
  Entrepreneur and engineer. CEO of Tesla and SpaceX, owner of X, founder of xAI.
  Frames decisions around first-principles physics, cost curves and existential risk.
speaking_style: >
  Terse and informal. Fragments, dry humour, engineering metaphors. States a
  position as a probability and moves on.
core_values:
  - First-principles reasoning over analogy
  - Speed of iteration and manufacturing scale
known_biases:
  - Over-optimistic timelines on hard hardware problems
  - Contempt for regulators and permitting
topics_of_expertise:
  - electric vehicles and batteries
  - rocketry and space access
model_override: null
enabled: true
source_feeds:
  - type: googlenews
    query: '"Elon Musk"'
    label: google-news-en
```

| Field | Why it matters |
|---|---|
| `id` | lowercase `a-z 0-9 _`, used by `/chat`, `/beliefs`, `/update` |
| `display_name`, `emoji` | how it appears in Telegram |
| `bio` | who they are — the model's background knowledge |
| `speaking_style` | **the difference between a persona and a summary** |
| `core_values` | what they optimise for |
| `known_biases` | documented blind spots, phrased neutrally; they make disagreements real |
| `topics_of_expertise` | where they should sound credible |
| `model_override` | optional `:free` model just for this person |
| `enabled` | off = never speaks |
| `source_feeds` | feeds Scout checks for fresh documents |

### Baseline beliefs live locally too

The first source-backed notes are committed under `knowledge/seeds/<id>.json`.
Each one contains a short document excerpt, title/date/URL and paraphrased
beliefs—never invented quotes. **Setup → Seed** embeds and imports these into
D1, so the three default personas don't start with empty belief timelines. Scout
then keeps adding fresher evidence. Seed is idempotent; running it again won't
duplicate these documents or beliefs.

When adding a new persona, you can also add `knowledge/seeds/<id>.json` in the
same format to give it a cited starting point. If you omit it, `/update <id>`
will gather and extract the initial beliefs from that persona's feeds.

### Feeds

| Type | Use | Fields |
|---|---|---|
| `googlenews` | their name in the news, English + Arabic | `query`, `label` |
| `blog` | personal site or company news (tries RSS, then scrapes) | `url`, `label` |
| `youtube` | channel by handle; transcripts added nightly | `handle` or `channel_id` |
| `podcast` | show notes are stored as text | `url`, `label` |
| `rss` | any feed | `url`, `label` |
| `rsshub` | X/Twitter via your own RSSHub | `route`, `label` |

### Also add the Arabic query

Council answers in Arabic and reads Arabic sources. Two feeds per person is the
minimum:

```yaml
  - type: googlenews
    query: '"إيلون ماسك"'
    label: google-news-ar
```

---

## What happens after you add it

1. **Seed** inserts the row into D1 and its feed list into `sources`.
2. **Scout** (every 6 hours, or `/update <id>`) fetches, dedupes by URL hash,
   chunks, embeds with `bge-m3`, and extracts up to 5 beliefs per document with a
   date and a source link. Changed stances become a new row; the old one gets
   `superseded_at` — that is the thought history behind `/beliefs`.
3. **The first debate** retrieves that person's 8 best chunks + 5 live beliefs,
   cites them as `S1…Sn`, and refuses to make a claim without one.

Until there are sources, the person still answers — clearly labelled
**inference — no stored source on this topic**. It never invents a citation.

---

## Test it in 30 seconds

```
/personas
/chat sarah_connor        one-to-one, same retrieval, its own memory thread
/beliefs sarah_connor     current stances + what changed
```

Then ask the council something the new person has an opinion about. Their answer
arrives in the same live round as the others.

---

## Rules that apply to every person

- Every message is labelled **simulated**.
- A claim about their view must cite a stored source; otherwise it is marked
  inference.
- No invented quotes: `is_quote` is only set for verbatim text, and paraphrases
  are rendered as paraphrases.
- Replies follow your language (Arabic or English) and stay under 120 words.
- Money / health / legal questions get a one-line "not financial advice" footer
  from Scribe, with Saudi context (SAR, SAMA, Sakani) where relevant.

---

## Before you start: credentials live in GitHub Secrets

**Nothing is stored in the repo.** The Worker gets its configuration from secrets
pushed by the Setup workflow; the deploy workflow runs `scripts/check-secrets.mjs`
first and refuses to deploy with a readable checklist if anything is missing.

```
Repo → Settings → Secrets and variables → Actions

Secrets:  TELEGRAM_BOT_TOKEN · OPENROUTER_API_KEY · CLOUDFLARE_API_TOKEN
          CLOUDFLARE_ACCOUNT_ID · ALLOWED_TELEGRAM_USER_ID · INTERNAL_TOKEN
          PUBLIC_BASE_URL
Variable: D1_DATABASE_ID
```

Full walkthrough: **[docs/SETUP.md](docs/SETUP.md)** · copy-paste commands:
**[docs/COMMANDS.md](docs/COMMANDS.md)**

---

## Read next

| | |
|---|---|
| [docs/SETUP.md](docs/SETUP.md) | first-time setup from a phone |
| [docs/COMMANDS.md](docs/COMMANDS.md) | every command, browser or Termux |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | five-agent flow, retrieval, request budget, data model |
| [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) | the tests and troubleshooting |
| `personas/_template.yaml` | copy this to start a person |
| `prompts/*.md` | every prompt, editable without code |

---

Council is a simulation. It is not affiliated with any of the people it
simulates. Nothing it says is financial, medical or legal advice.
