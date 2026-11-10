import type { Ctx } from '../types';

export const EMBED_DIMS = 1024;

/** bge-m3 accepts batches; 25 keeps each call small and quick. */
const BATCH = 25;

export function embedModel(ctx: Ctx): string {
  return (ctx.env.EMBED_MODEL as string) || '@cf/baai/bge-m3';
}

/**
 * Embeddings via Workers AI (binding when available, REST fallback for Node
 * scripts / Actions). Multilingual — Arabic is fine.
 */
export async function embedTexts(ctx: Ctx, texts: string[]): Promise<number[][]> {
  const clean = texts.map((t) => t.replace(/\s+/g, ' ').trim().slice(0, 6000));
  const out: number[][] = [];
  for (let i = 0; i < clean.length; i += BATCH) {
    const batch = clean.slice(i, i + BATCH);
    const vectors = await embedBatch(ctx, batch);
    if (vectors.length !== batch.length) throw new Error('Embedding count mismatch');
    out.push(...vectors);
  }
  return out;
}

export async function embedOne(ctx: Ctx, text: string): Promise<number[]> {
  const [v] = await embedTexts(ctx, [text]);
  if (!v) throw new Error('Empty embedding');
  return v;
}

async function embedBatch(ctx: Ctx, texts: string[]): Promise<number[][]> {
  const model = embedModel(ctx);

  if (ctx.env.AI) {
    try {
      const res = (await ctx.env.AI.run(model, { text: texts } as never)) as unknown as { data?: number[][] };
      if (Array.isArray(res?.data) && res.data.length === texts.length) return res.data;
    } catch (e) {
      // fall through to REST
      if (!ctx.env.CF_ACCOUNT_ID || !ctx.env.CF_API_TOKEN) throw e;
    }
  }

  const account = ctx.env.CF_ACCOUNT_ID;
  const token = ctx.env.CF_API_TOKEN;
  if (!account || !token) throw new Error('No AI binding and no CF_ACCOUNT_ID/CF_API_TOKEN for embeddings');

  const base = (
    (ctx.env.CF_AI_BASE_URL as string) ||
    `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run`
  ).replace(/\/+$/, '');

  const res = await fetch(`${base}/${model}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: texts }),
    signal: AbortSignal.timeout(45_000),
  });
  const json = (await res.json()) as { result?: { data?: number[][] }; errors?: unknown };
  if (!res.ok || !json.result?.data) {
    throw new Error(`Embedding failed: HTTP ${res.status} ${JSON.stringify(json.errors ?? '').slice(0, 200)}`);
  }
  return json.result.data;
}

// ---------------------------------------------------------------- vector codec

/** Float32 → base64, stored as TEXT in D1. ~5.4KB per vector. */
export function encodeVector(vec: number[] | Float32Array): string {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let binary = '';
  const CHUNK = 0x2000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function decodeVector(b64: string): Float32Array {
  if (!b64) return new Float32Array(0);
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Float32Array(bytes.buffer, 0, Math.floor(bytes.byteLength / 4));
  } catch {
    return new Float32Array(0);
  }
}

/** Cosine similarity. Vectors are normalised by bge-m3, but stay safe. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** Recency weight with a configurable half-life (default 90 days). */
export function recencyWeight(dateIso: string | null, halfLifeDays: number, now = Date.now()): number {
  if (!dateIso) return 0.5;
  const t = Date.parse(dateIso);
  if (!Number.isFinite(t)) return 0.5;
  const ageDays = Math.max(0, (now - t) / 86_400_000);
  const halfLife = Math.max(1, halfLifeDays);
  return Math.pow(0.5, ageDays / halfLife);
}
