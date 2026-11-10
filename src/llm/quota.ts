import type { Ctx } from '../types';
import { getSetting, setSetting } from '../db/repo';

export interface Quota {
  remaining: number | null;
  limit: number | null;
  used: number | null;
  label: string | null;
  isFreeTier: boolean | null;
  raw: unknown;
  fetchedAt: string;
  source: 'live' | 'cache' | 'error';
  error?: string;
}

const CACHE_KEY = 'quota_cache';
const TTL_MS = 5 * 60 * 1000;

/**
 * Reads the real remaining free quota from OpenRouter.
 * Never hard-code limits: the numbers come from /api/v1/key.
 */
export async function getQuota(ctx: Ctx, opts: { force?: boolean } = {}): Promise<Quota> {
  if (!opts.force) {
    const cached = await getSetting<Quota>(ctx, CACHE_KEY);
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < TTL_MS) {
      return { ...cached, source: 'cache' };
    }
  }

  try {
    const base = ((ctx.env.OPENROUTER_BASE_URL as string) || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
    const res = await fetch(`${base}/key`, {
      headers: { authorization: `Bearer ${ctx.env.OPENROUTER_API_KEY}` },
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return failed(`HTTP ${res.status}: ${text.slice(0, 160)}`);
    }
    const parsed = JSON.parse(text) as { data?: Record<string, unknown> };
    const data = (parsed.data ?? {}) as Record<string, unknown>;

    const daily = data.free_model_daily_requests;
    let limit: number | null = null;
    let remaining: number | null = null;

    if (typeof daily === 'number') {
      remaining = daily;
    } else if (daily && typeof daily === 'object') {
      const d = daily as Record<string, unknown>;
      limit = asNumber(d.limit);
      remaining = asNumber(d.remaining ?? d.left ?? d.available);
      const usedInDaily = asNumber(d.usage ?? d.used);
      if (remaining == null && limit != null && usedInDaily != null) remaining = Math.max(0, limit - usedInDaily);
    }

    const limitMain = asNumber(data.limit);
    const usageMain = asNumber(data.usage);
    if (limit == null) limit = limitMain ?? asNumber(data.free_model_daily_requests_limit);
    if (remaining == null && limitMain != null && usageMain != null) remaining = Math.max(0, limitMain - usageMain);
    if (remaining == null) remaining = asNumber(data.limit_remaining ?? data.credits_remaining);

    const quota: Quota = {
      remaining,
      limit,
      used: usageMain,
      label: typeof data.label === 'string' ? data.label : null,
      isFreeTier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null,
      raw: data,
      fetchedAt: new Date().toISOString(),
      source: 'live',
    };
    try {
      await setSetting(ctx, CACHE_KEY, quota);
    } catch {
      // Caching is best-effort.
    }
    return quota;
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }
}

function failed(message: string): Quota {
  return {
    remaining: null,
    limit: null,
    used: null,
    label: null,
    isFreeTier: null,
    raw: null,
    fetchedAt: new Date().toISOString(),
    source: 'error',
    error: message,
  };
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Cheap pre-flight check so we do not burn a question when the day is used up. */
export async function hasQuotaFor(ctx: Ctx, requests: number): Promise<{ ok: boolean; note: string }> {
  const q = await getQuota(ctx);
  if (q.remaining == null) {
    return { ok: true, note: 'quota unknown (OpenRouter did not report it) — continuing' };
  }
  if (q.remaining < requests) {
    return {
      ok: false,
      note: `Only ${q.remaining} free request(s) left today; this needs about ${requests}.`,
    };
  }
  return { ok: true, note: `${q.remaining} free requests left today` };
}

export function formatQuota(q: Quota): string {
  if (q.source === 'error') return `unknown (${q.error ?? 'error'})`;
  if (q.remaining == null) return `unknown (OpenRouter did not report a number)`;
  const limit = q.limit != null ? `/${q.limit}` : '';
  const cached = q.source === 'cache' ? ' · cached' : '';
  return `${q.remaining}${limit} left${cached}`;
}
