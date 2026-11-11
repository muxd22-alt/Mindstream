import type { Ctx } from '../types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmAttempt {
  model: string;
  ok: boolean;
  status?: number;
  error?: string;
  ms: number;
}

export interface LlmResult {
  text: string;
  model: string;
  attempts: LlmAttempt[];
  truncated: boolean;
}

export interface LlmOptions {
  messages: ChatMessage[];
  modelOverride?: string | null;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Free-form label written to the run log, e.g. "round1". */
  label?: string;
}

export class FatalLlmError extends Error {}

/**
 * Ordered fallback across the MODELS list.
 * 429 / 402 / 5xx / empty output / network error → try the next model.
 * 401 / 403 → abort: the API key itself is wrong.
 */
export async function llm(ctx: Ctx, opts: LlmOptions): Promise<LlmResult> {
  const models = orderModels(ctx, opts.modelOverride);
  const attempts: LlmAttempt[] = [];
  const timeoutMs = opts.timeoutMs ?? 75_000;
  const base = ((ctx.env.OPENROUTER_BASE_URL as string) || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

  for (const model of models) {
    const started = Date.now();
    try {
      const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ctx.env.OPENROUTER_API_KEY}`,
          'content-type': 'application/json',
          'HTTP-Referer': ctx.env.PUBLIC_BASE_URL || 'https://github.com/muxd22-alt/Mindstream',
          'X-Title': 'Council',
        },
        body: JSON.stringify({
          model,
          messages: opts.messages,
          temperature: opts.temperature ?? 0.75,
          max_tokens: opts.maxTokens ?? 2200,
          provider: { sort: 'throughput' },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const bodyText = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status === 402 || res.status >= 500 || res.status === 404;
        attempts.push({ model, ok: false, status: res.status, error: brief(bodyText), ms: Date.now() - started });
        if (res.status === 401 || res.status === 403) {
          throw new FatalLlmError(`OpenRouter rejected the API key (${res.status}).`);
        }
        if (retryable) continue;
        continue;
      }

      const parsed = safeParse(bodyText);
      if (!parsed) {
        attempts.push({ model, ok: false, error: 'non-JSON response', ms: Date.now() - started });
        continue;
      }
      if (parsed.error) {
        attempts.push({ model, ok: false, error: brief(JSON.stringify(parsed.error)), ms: Date.now() - started });
        continue;
      }
      const choice = parsed.choices?.[0];
      const text = typeof choice?.message?.content === 'string' ? choice.message.content : '';
      if (!text.trim()) {
        attempts.push({ model, ok: false, error: 'empty completion', ms: Date.now() - started });
        continue;
      }
      attempts.push({ model, ok: true, ms: Date.now() - started });
      return {
        text,
        model,
        attempts,
        truncated: choice?.finish_reason === 'length',
      };
    } catch (e) {
      if (e instanceof FatalLlmError) throw e;
      attempts.push({
        model,
        ok: false,
        error: e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200),
        ms: Date.now() - started,
      });
      continue;
    }
  }

  throw new Error(
    `All ${models.length} models failed. Last errors: ${attempts
      .slice(-3)
      .map((a) => `${a.model}: ${a.status ?? ''} ${a.error ?? ''}`.trim())
      .join(' | ')}`,
  );
}

function orderModels(ctx: Ctx, override?: string | null): string[] {
  const list = [...ctx.models];
  if (override && list.includes(override)) {
    return [override, ...list.filter((m) => m !== override)];
  }
  return list;
}

function brief(s: string): string {
  return s.replace(/\s+/g, ' ').slice(0, 240);
}

interface RawCompletion {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
  error?: unknown;
}

function safeParse(text: string): RawCompletion | null {
  try {
    return JSON.parse(text) as RawCompletion;
  } catch {
    return null;
  }
}
