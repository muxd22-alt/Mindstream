#!/usr/bin/env node
// Fails fast with a readable checklist when a required GitHub Secret/Variable
// is missing. Secrets are the ONLY place credentials live in this project.

const required = [
  ['TELEGRAM_BOT_TOKEN', 'secret', 'BotFather → /newbot'],
  ['OPENROUTER_API_KEY', 'secret', 'openrouter.ai/keys'],
  ['CLOUDFLARE_API_TOKEN', 'secret', 'dash.cloudflare.com → API Tokens (Workers + D1 edit)'],
  ['CLOUDFLARE_ACCOUNT_ID', 'secret', 'Workers dashboard sidebar'],
  ['ALLOWED_TELEGRAM_USER_ID', 'secret', 'numeric id from @userinfobot'],
  ['INTERNAL_TOKEN', 'secret', 'random string, e.g. openssl rand -hex 24'],
  ['PUBLIC_BASE_URL', 'secret', 'https://council.<subdomain>.workers.dev'],
  ['D1_DATABASE_ID', 'variable', 'Cloudflare → D1 → council → Database ID'],
];

const optional = [
  ['CF_ACCOUNT_ID', 'secret'],
  ['CF_API_TOKEN', 'secret'],
  ['TELEGRAM_WEBHOOK_SECRET', 'secret'],
  ['RSSHUB_URL', 'secret'],
  ['GOOGLE_CLIENT_ID', 'secret'],
  ['GOOGLE_CLIENT_SECRET', 'secret'],
  ['GOOGLE_REFRESH_TOKEN', 'secret'],
  ['GOOGLE_DRIVE_FOLDER_ID', 'secret'],
];

const missing = required.filter(([key]) => !process.env[key] || !String(process.env[key]).trim());

if (missing.length) {
  console.error('\n✗ Missing GitHub configuration\n');
  for (const [key, kind, hint] of missing) {
    console.error(`  ${kind.padEnd(8)} ${key.padEnd(26)} ← ${hint}`);
  }
  console.error('\nAdd them here: repo → Settings → Secrets and variables → Actions.');
  console.error('Then re-run this workflow.\n');
  process.exit(1);
}

const base = process.env.PUBLIC_BASE_URL ?? '';
if (!/^https:\/\//.test(base)) {
  console.error('✗ PUBLIC_BASE_URL must be an https URL');
  process.exit(1);
}
if (!/^[a-z0-9_]{2,64}$/i.test(process.env.INTERNAL_TOKEN ?? '')) {
  console.error('✗ INTERNAL_TOKEN should be at least 16 chars, letters/numbers (or any long random string)');
  process.exit(1);
}
if (!/^\d{8,15}$/.test(process.env.ALLOWED_TELEGRAM_USER_ID ?? '')) {
  console.error('✗ ALLOWED_TELEGRAM_USER_ID must be a numeric Telegram user id');
  process.exit(1);
}

const missingOptional = optional.filter(([key]) => !process.env[key]).map(([k]) => k);
console.log('✓ required secrets present');
if (missingOptional.length) console.log(`· optional, not set: ${missingOptional.join(', ')}`);
console.log(`· worker url: ${base}`);
console.log(`· mini app:   ${base}/app`);
