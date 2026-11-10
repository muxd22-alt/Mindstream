import type { Env } from '../types';

export function getAllowedUserId(env: Env): number | null {
  const n = Number(env.ALLOWED_TELEGRAM_USER_ID);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Hard rule: only the owner can use the bot. Everyone else is ignored silently. */
export function isAllowedUser(env: Env, userId: number | undefined | null): boolean {
  const allowed = getAllowedUserId(env);
  if (!allowed) return false;
  return Number(userId) === allowed;
}

/** GitHub Actions → Worker. Constant-time-ish compare, no length leak beyond hash. */
export async function verifyInternalToken(env: Env, req: Request): Promise<boolean> {
  const expected = env.INTERNAL_TOKEN;
  if (!expected) return false;
  const provided = req.headers.get('x-internal-token') ?? '';
  if (provided.length !== expected.length) return false;
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function verifyTelegramSecret(env: Env, req: Request): boolean {
  const expected = env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) return true; // not configured → rely on the unguessable URL + user check
  return req.headers.get('x-telegram-bot-api-secret-token') === expected;
}
