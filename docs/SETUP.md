# Council — first-time setup (once)

Everything here happens from your phone. After this you will never touch it again
except to add people (see the main README).

**All credentials live in GitHub Secrets.** Nothing is stored in the repo, in
`.env`, or in the Worker config. The deploy workflow runs
`scripts/check-secrets.mjs` first and refuses to deploy if anything is missing,
so you always get a clear checklist instead of a broken bot.

A $10 OpenRouter top-up raises the free-model allowance to **1,000 requests/day**
instead of 50. Council reads the real number from OpenRouter (`/status`) rather
than assuming either.

---

## 1. Telegram — **Telegram app**

1. **@BotFather** → `/newbot` → name + username → copy the token
   (`123456789:AA…`).
2. **@userinfobot** → `/start` → copy your numeric id.
3. Leave the bot alone for now; the webhook is set in step 5.

## 2. OpenRouter — **browser**

<https://openrouter.ai/keys> → **Create key** → copy.

Free `:free` models need no payment method.

## 3. Cloudflare — **browser**

1. **Workers & Pages → D1 → Create database**, name it exactly **`council`**.
2. Open it → copy the **Database ID** (UUID).
3. <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** →
   **Edit Cloudflare Workers** template → add **Account → D1 → Edit** → create →
   copy the token.
4. Copy the **Account ID** from the Workers overview sidebar.
5. Note your workers.dev subdomain; the Worker will be at
   `https://council.<subdomain>.workers.dev`.

## 4. GitHub — **browser (GitHub mobile works)**

Repo → **Settings → Secrets and variables → Actions**.

### Secrets

| Secret | Where it comes from | Required |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | BotFather | ✅ |
| `OPENROUTER_API_KEY` | openrouter.ai/keys | ✅ |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API tokens | ✅ |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare sidebar | ✅ |
| `ALLOWED_TELEGRAM_USER_ID` | @userinfobot | ✅ |
| `INTERNAL_TOKEN` | any long random string | ✅ |
| `PUBLIC_BASE_URL` | `https://council.<subdomain>.workers.dev` | ✅ |
| `CF_ACCOUNT_ID` | same as the account id | recommended |
| `CF_API_TOKEN` | token with **Workers AI → Read** | recommended |
| `TELEGRAM_WEBHOOK_SECRET` | random string | optional |
| `RSSHUB_URL` | your RSSHub base URL | optional |
| `GOOGLE_CLIENT_ID` | Google Cloud OAuth client | optional |
| `GOOGLE_CLIENT_SECRET` | Google Cloud OAuth client | optional |
| `GOOGLE_REFRESH_TOKEN` | OAuth playground | optional |
| `GOOGLE_DRIVE_FOLDER_ID` | Drive folder URL | optional |

### Variable (not a secret)

| Variable | Value |
|---|---|
| `D1_DATABASE_ID` | the UUID from step 3 |

## 5. Deploy — **browser (GitHub mobile)**

Repo → **Actions → Setup → Run workflow**:

```
mode: full
force_seed: false
```

It runs, in order:

1. `scripts/check-secrets.mjs` — fails with a checklist if anything is missing.
2. `wrangler d1 migrations apply council --remote` — creates the schema.
3. `wrangler secret bulk` — pushes every secret to the Worker.
4. builds the Mini App, bundles prompts/personas, `wrangler deploy`.
5. seeds `personas/*.yaml` and the cited baseline in `knowledge/seeds/*.json` into D1.
6. sets the Telegram webhook, command list and the **Council** menu button.

Then open the bot → `/start` → `/update` (fetches fresher sources) → ask a question.
The initial 3 source documents and beliefs are already in D1 from the local seed pack.

---

## What the workflows do

| Workflow | Trigger | Purpose |
|---|---|---|
| **Setup** | manual | migrate, push secrets, deploy, seed, set webhook |
| **Deploy** | push to `main`, manual | typecheck, self-test, build, deploy, re-point webhook |
| **Scout** | every 6h, manual | fetch sources → dedupe → embed → extract beliefs |
| **Daily digest** | 04:00 UTC (07:00 Riyadh) | "what changed" per persona, max 3 bullets |
| **YouTube transcripts** | daily, manual | fetch transcripts; skips quietly when blocked |
| **Backup D1** | weekly, manual | SQL dump as a downloadable artifact |
| **Restore D1** | manual | apply a dump back to D1 |

Every one of them reads credentials from GitHub Secrets only.

---

## Local development (optional) — **Termux or laptop**

```bash
git clone https://github.com/muxd22-alt/Mindstream.git
cd council
npm install
cp .dev.vars.example .dev.vars     # only for local wrangler dev
npm run web:build
npm run dev
```

```bash
npx wrangler d1 migrations apply council --local
npm run selftest          # parsing, citations, seed data, HMAC; no keys required
npm run typecheck
```

`.dev.vars` is gitignored and is **not** how production gets its secrets — GitHub
Secrets are pushed to the Worker by the Setup workflow.

### Offline end-to-end run (no quota spent)

```bash
node scripts/mock-llm.mjs 8899
# add to .dev.vars:
#   OPENROUTER_BASE_URL=http://127.0.0.1:8899/api/v1
#   CF_AI_BASE_URL=http://127.0.0.1:8899/ai/run
```

Then `POST /internal/scout` and `POST /api/debates` + `POST /internal/drain` give
you a full debate with canned answers.
