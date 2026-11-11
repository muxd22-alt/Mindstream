import type { Ctx, Env, Settings } from './types';
import { Db, parseJson } from './db/client';

/**
 * Sane defaults. MODELS in wrangler.toml / secrets is authoritative — this list
 * only exists so /status is never empty. Every entry is a ":free" model.
 */
export const DEFAULT_MODELS = [
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'thinkingmachines/inkling-2-small:free',
  'nvidia/nemotron-3.5-super-vl:free',
  'recursive/flint-v1.0:free',
  'liquid/lfm-3-1.7b:free',
];

export const DEFAULT_SETTINGS: Settings = {
  recency_half_life_days: 90,
  rounds: 2,
  persona_word_limit: 120,
  language: 'auto',
  models_override: null,
  max_docs_per_scout_run: 6,
  max_chunks_per_doc: 12,
  parallel_round1: false,
};

export function intOr(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : fallback;
}

export function splitList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Ordered model fallback list. Paid models are dropped unless the operator
 * explicitly sets ALLOW_PAID_MODELS=1 (hard rule: free by default).
 */
export function modelList(env: Env, overrideModels?: string | null): string[] {
  const allowPaid = env.ALLOW_PAID_MODELS === '1';
  const raw = [...splitList(overrideModels), ...splitList(env.MODELS), ...DEFAULT_MODELS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of raw) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (!allowPaid && !id.includes(':free')) continue;
    out.push(id);
  }
  return out;
}

export function allowedUserId(env: Env): number | null {
  const n = Number(env.ALLOWED_TELEGRAM_USER_ID);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function publicBaseUrl(env: Env): string {
  return (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
}

export async function loadSettings(db: Db, env: Env): Promise<Settings> {
  let stored: Record<string, unknown> = {};
  try {
    const rows = await db.all<{ key: string; value: string }>('select key, value from settings');
    stored = Object.fromEntries(rows.map((r) => [r.key, parseJson(r.value, null as unknown)]));
  } catch {
    // Fresh project before migration, or DB unreachable: fall back to env only.
    stored = {};
  }
  const num = (key: keyof Settings | 'max_docs_per_scout_run', fallback: number) => {
    const v = stored[key];
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const lang = typeof stored.language === 'string' ? stored.language : 'auto';
  const modelsOverride = typeof stored.models_override === 'string' ? stored.models_override : null;

  return {
    recency_half_life_days: num('recency_half_life_days', intOr(env.RECENCY_HALF_LIFE_DAYS, 90)),
    rounds: Math.min(4, Math.max(1, num('rounds', 2))),
    persona_word_limit: Math.min(400, Math.max(40, num('persona_word_limit', intOr(env.PERSONA_WORD_LIMIT, 120)))),
    language: lang === 'ar' || lang === 'en' ? lang : 'auto',
    models_override: modelsOverride,
    max_docs_per_scout_run: Math.min(20, Math.max(1, num('max_docs_per_scout_run', intOr(env.MAX_DOCS_PER_SCOUT_RUN, 6)))),
    max_chunks_per_doc: Math.min(60, Math.max(1, num('max_chunks_per_doc', intOr(env.SCOUT_MAX_CHUNKS_PER_DOC, 12)))),
    parallel_round1: stored.parallel_round1 === undefined ? false : toBool(stored.parallel_round1),
  };
}

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v === 'true' || v === '1';
  return true;
}

export async function createCtx(env: Env): Promise<Ctx> {
  if (!env.DB) throw new Error('D1 binding "DB" is missing. Run the Setup action or check wrangler.toml.');
  const db = new Db(env.DB);
  const settings = await loadSettings(db, env);
  return {
    env,
    db,
    settings,
    models: modelList(env, settings.models_override),
    now: new Date(),
  };
}

export function jsonResponse(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

export function errorResponse(message: string, status = 400, detail?: unknown): Response {
  return jsonResponse({ ok: false, error: message, detail }, status);
}
