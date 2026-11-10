import type { Env } from '../types';
import { isAllowedUser } from '../telegram/guard';

export interface InitDataUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface InitDataResult {
  ok: boolean;
  user?: InitDataUser;
  error?: string;
}

/**
 * Validates Telegram WebApp initData.
 * secret = HMAC_SHA256(key="WebAppData", data=bot_token)
 * hash   = HMAC_SHA256(key=secret, data=data_check_string)
 */
export async function parseInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 24 * 3600,
): Promise<InitDataResult> {
  if (!initData) return { ok: false, error: 'missing initData' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'missing hash' };
  params.delete('hash');

  const keys: string[] = [];
  params.forEach((_value, key) => keys.push(key));
  const pairs: string[] = [];
  for (const key of keys.sort()) {
    pairs.push(`${key}=${params.get(key) ?? ''}`);
  }
  const dataCheckString = pairs.join('\n');

  const enc = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    enc.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const secret = await crypto.subtle.sign('HMAC', hmacKey, enc.encode(botToken));
  const signKey = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', signKey, enc.encode(dataCheckString));
  const computed = [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');

  if (!timingSafeEqual(computed, hash.toLowerCase())) return { ok: false, error: 'bad signature' };

  const authDate = Number(params.get('auth_date') ?? 0);
  if (Number.isFinite(authDate) && authDate > 0) {
    const age = Date.now() / 1000 - authDate;
    if (age > maxAgeSeconds) return { ok: false, error: 'expired initData' };
  }

  const rawUser = params.get('user');
  if (!rawUser) return { ok: false, error: 'no user in initData' };
  try {
    const user = JSON.parse(rawUser) as InitDataUser;
    if (!user?.id) return { ok: false, error: 'bad user payload' };
    return { ok: true, user };
  } catch {
    return { ok: false, error: 'bad user json' };
  }
}

export interface AuthResult {
  ok: boolean;
  userId: number | null;
  error?: string;
}

export async function authenticate(env: Env, req: Request): Promise<AuthResult> {
  const internal = req.headers.get('x-internal-token');
  if (internal && env.INTERNAL_TOKEN && internal === env.INTERNAL_TOKEN) {
    return { ok: true, userId: null };
  }

  const initData = req.headers.get('x-telegram-init-data') ?? '';
  if (initData) {
    const parsed = await parseInitData(initData, env.TELEGRAM_BOT_TOKEN);
    if (!parsed.ok) return { ok: false, userId: null, error: parsed.error };
    if (!isAllowedUser(env, parsed.user?.id)) {
      return { ok: false, userId: null, error: 'not allowed' };
    }
    return { ok: true, userId: parsed.user?.id ?? null };
  }

  // Local development escape hatch, opt-in and still owner-locked.
  if (env.MINIAPP_DEV_BYPASS === '1') {
    const id = Number(env.ALLOWED_TELEGRAM_USER_ID);
    if (Number.isFinite(id) && id > 0) return { ok: true, userId: id };
  }

  return { ok: false, userId: null, error: 'auth required' };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
