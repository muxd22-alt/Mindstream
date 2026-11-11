# Council — phone commands

Nothing here needs a laptop. **Termux** is only for the optional CLI path.

## Browser (GitHub mobile / any browser)

| Task | Where | What |
|---|---|---|
| Deploy / redeploy | Actions → **Deploy** → Run workflow | builds, typechecks, deploys, re-points webhook |
| First setup | Actions → **Setup** → Run workflow, `mode: full` | migrate + secrets + deploy + seed + webhook |
| Apply a schema change | Actions → **Setup**, `mode: migrate` | `wrangler d1 migrations apply` |
| Push secrets again | Actions → **Setup**, `mode: secrets` | `wrangler secret bulk` from GitHub Secrets |
| Seed after adding a person | Actions → **Setup**, `mode: seed` | pushes `personas/*.yaml` into D1 |
| Refresh sources now | Actions → **Scout** → Run workflow | optional `persona`, `query`, `max_docs` |
| Send the daily digest now | Actions → **Daily digest** | same as 07:00 Riyadh |
| Fetch YouTube transcripts | Actions → **YouTube transcripts** | skips quietly if blocked |
| Back up the database | Actions → **Backup D1** | downloads a `.sql` artifact |
| Restore | Actions → **Restore D1**, `sql_url` or `sql_path` | applies a dump |

## Telegram

```
/start                      how it works
/ask <question>             new debate
<any message>               continues the live thread
/new                        start a fresh thread
/end                        Scribe final summary + .md pack
/more                       one more round
/me <text>                  join the conversation
/dig #saudi_mortgage_sama   Scout + quick debate
/personas                   list people
/chat elon                  1:1 chat
/council                    back to group mode
/persona add <name>         Scout drafts a YAML for approval
/persona clone elon elon_2020
/persona export elon
/persona import             then send the .yaml file
/persona on|off elon
/beliefs elon [topic]       stances + superseded history
/update [persona]           run Scout now
/notebook [debate_id]       rebuild the pack
/status                     model in use, free requests left, docs
```

## Termux — optional CLI

```bash
pkg install nodejs git -y
git clone https://github.com/muxd22-alt/Mindstream.git
cd council
npm install
```

```bash
# log in once
npx wrangler login

# create the database (copy the printed database_id into GitHub → Variables)
npx wrangler d1 create council

# apply the schema remotely
npx wrangler d1 migrations apply council --remote

# build + deploy by hand
npm run web:build && npm run assets
npx wrangler deploy

# point Telegram at the Worker
TELEGRAM_BOT_TOKEN=... PUBLIC_BASE_URL=https://council.xxx.workers.dev \
  node scripts/set-webhook.mjs

# seed personas / run Scout / send digest
PUBLIC_BASE_URL=... INTERNAL_TOKEN=... node scripts/call.mjs /internal/seed '{}'
PUBLIC_BASE_URL=... INTERNAL_TOKEN=... node scripts/call.mjs /internal/scout '{}'
PUBLIC_BASE_URL=... INTERNAL_TOKEN=... node scripts/call.mjs /internal/daily '{}'

# tests
npm run selftest
npm run typecheck

# offline end-to-end, no quota
node scripts/mock-llm.mjs 8899
```

## Secrets checklist

Repo → Settings → Secrets and variables → Actions.

Required secrets: `TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`,
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ALLOWED_TELEGRAM_USER_ID`,
`INTERNAL_TOKEN`, `PUBLIC_BASE_URL`.

Required variable: `D1_DATABASE_ID`.

Recommended: `CF_ACCOUNT_ID`, `CF_API_TOKEN`.
Optional: `TELEGRAM_WEBHOOK_SECRET`, `RSSHUB_URL`, `GOOGLE_*`.

`scripts/check-secrets.mjs` runs before every deploy and lists exactly what is
missing. Secrets are the only place credentials live.
