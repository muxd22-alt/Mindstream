import type { Env } from '../types';

interface TgResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export class TelegramError extends Error {
  constructor(message: string, readonly code?: number, readonly retryAfter?: number) {
    super(message);
    this.name = 'TelegramError';
  }
}

const API = 'https://api.telegram.org';

async function call<T>(env: Env, method: string, payload: unknown, attempt = 0): Promise<T> {
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => ({}))) as TgResponse<T>;

  if (json.ok && json.result !== undefined) return json.result;

  if (json.error_code === 429 && attempt < 2) {
    const wait = Math.min((json.parameters?.retry_after ?? 2) * 1000, 8000);
    await sleep(wait);
    return call<T>(env, method, payload, attempt + 1);
  }
  throw new TelegramError(json.description ?? `Telegram ${method} failed`, json.error_code, json.parameters?.retry_after);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SendOptions {
  replyTo?: number;
  disablePreview?: boolean;
  replyMarkup?: unknown;
}

export async function sendMessage(
  env: Env,
  chatId: number | string,
  html: string,
  opts: SendOptions = {},
): Promise<number | null> {
  const chunks = splitForTelegram(html, 4000);
  let lastId: number | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const result = await call<{ message_id: number }>(env, 'sendMessage', {
      chat_id: chatId,
      text: chunks[i],
      parse_mode: 'HTML',
      reply_to_message_id: i === 0 ? opts.replyTo : undefined,
      allow_sending_without_reply: true,
      link_preview_options: { is_disabled: opts.disablePreview ?? true },
      reply_markup: i === chunks.length - 1 ? opts.replyMarkup : undefined,
    });
    lastId = result?.message_id ?? lastId;
  }
  return lastId;
}

export async function editMessage(
  env: Env,
  chatId: number | string,
  messageId: number,
  html: string,
): Promise<void> {
  try {
    await call(env, 'editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch {
    // Editing is cosmetic; ignore failures.
  }
}

export async function sendChatAction(env: Env, chatId: number | string, action = 'typing'): Promise<void> {
  try {
    await call(env, 'sendChatAction', { chat_id: chatId, action });
  } catch {
    // non-critical
  }
}

export async function sendDocument(
  env: Env,
  chatId: number | string,
  filename: string,
  content: string | Uint8Array,
  caption?: string,
): Promise<boolean> {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) {
    form.append('caption', caption.slice(0, 1000));
    form.append('parse_mode', 'HTML');
  }
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  form.append('document', new Blob([copy.buffer as ArrayBuffer], { type: 'text/plain; charset=utf-8' }), filename);

  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const json = (await res.json().catch(() => ({}))) as TgResponse<unknown>;
  return !!json.ok;
}

export async function deleteMessage(env: Env, chatId: number | string, messageId: number): Promise<void> {
  try {
    await call(env, 'deleteMessage', { chat_id: chatId, message_id: messageId });
  } catch {
    // ignore
  }
}

export async function answerCallbackQuery(env: Env, id: string, text?: string): Promise<void> {
  try {
    await call(env, 'answerCallbackQuery', { callback_query_id: id, text: text?.slice(0, 200) });
  } catch {
    // ignore
  }
}

export async function setMyCommands(env: Env): Promise<void> {
  await call(env, 'setMyCommands', {
    commands: [
      { command: 'ask', description: 'Ask the council a question' },
      { command: 'council', description: 'Group debate mode (default)' },
      { command: 'chat', description: '1:1 chat with one persona' },
      { command: 'personas', description: 'List personas' },
      { command: 'persona', description: 'add/clone/export/import/on/off' },
      { command: 'update', description: 'Run Scout now' },
      { command: 'beliefs', description: 'Show stances + history' },
      { command: 'dig', description: 'Research a hashtag or keywords' },
      { command: 'notebook', description: 'Build a NotebookLM pack' },
      { command: 'more', description: 'Another round' },
      { command: 'me', description: 'Join the debate yourself' },
      { command: 'status', description: 'Models, quota, last Scout run' },
      { command: 'help', description: 'How Council works' },
    ],
  });
}

export async function setChatMenuButton(env: Env, webAppUrl: string): Promise<void> {
  await call(env, 'setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: 'Council',
      web_app: { url: webAppUrl },
    },
  });
}

export async function setWebhook(env: Env, url: string, secret?: string): Promise<unknown> {
  return call(env, 'setWebhook', {
    url,
    secret_token: secret || undefined,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
}

export async function getWebhookInfo(env: Env): Promise<unknown> {
  return call(env, 'getWebhookInfo', {});
}

export async function getMe(env: Env): Promise<{ id: number; username?: string; first_name?: string }> {
  return call(env, 'getMe', {});
}

export async function downloadFile(env: Env, fileId: string): Promise<string | null> {
  const file = await call<{ file_path?: string }>(env, 'getFile', { file_id: fileId });
  if (!file.file_path) return null;
  const res = await fetch(`${API}/file/bot${env.TELEGRAM_BOT_TOKEN}/${file.file_path}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) return null;
  return res.text();
}

/** Telegram caps messages at 4096 chars; split on blank lines then hard-cut. */
export function splitForTelegram(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut < limit * 0.3) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.trim()) parts.push(rest);
  return parts;
}
