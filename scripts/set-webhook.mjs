#!/usr/bin/env node
// Sets the Telegram webhook, command list and the Mini App menu button.
// Usage: TELEGRAM_BOT_TOKEN=... PUBLIC_BASE_URL=https://... node scripts/set-webhook.mjs
const token = process.env.TELEGRAM_BOT_TOKEN;
const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';

if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set');
  process.exit(1);
}
if (!base.startsWith('https://')) {
  console.error('PUBLIC_BASE_URL must be an https URL');
  process.exit(1);
}

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (!json.ok) {
    console.error(`${method} failed:`, json.description || json);
    process.exitCode = 1;
  } else {
    console.log(`✓ ${method}`);
  }
  return json;
}

await tg('setWebhook', {
  url: `${base}/telegram/webhook`,
  secret_token: secret || undefined,
  allowed_updates: ['message', 'callback_query'],
  drop_pending_updates: true,
});

await tg('setMyCommands', {
  commands: [
    { command: 'ask', description: 'Ask the council' },
    { command: 'council', description: 'Group debate mode' },
    { command: 'chat', description: '1:1 chat with a persona' },
    { command: 'personas', description: 'List personas' },
    { command: 'persona', description: 'add / clone / export / import / on / off' },
    { command: 'update', description: 'Run Scout now' },
    { command: 'beliefs', description: 'Stances and history' },
    { command: 'dig', description: 'Research a hashtag' },
    { command: 'notebook', description: 'NotebookLM pack' },
    { command: 'more', description: 'Another round' },
    { command: 'me', description: 'Join the debate' },
    { command: 'status', description: 'Models, quota, sources' },
    { command: 'help', description: 'How Council works' },
  ],
});

await tg('setChatMenuButton', {
  menu_button: {
    type: 'web_app',
    text: 'Council',
    web_app: { url: `${base}/app` },
  },
});

const info = await tg('getWebhookInfo', {});
console.log(JSON.stringify(info.result ?? {}, null, 2));
