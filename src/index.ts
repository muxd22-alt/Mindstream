import type { Ctx, Env } from './types';
import { createCtx, errorResponse, jsonResponse } from './config';
import { handleApi } from './api/miniapp';
import { handleUpdate, type TgUpdate } from './telegram/webhook';
import { verifyInternalToken, verifyTelegramSecret } from './telegram/guard';
import { drainQueue } from './jobs/runner';
import { syncSeedPersonas } from './personas/loader';
import { runScout, runDailyDigest } from './agents/scout';
import { ingestExternalDocs } from './agents/ingest';
import { getWebhookInfo, setChatMenuButton, setMyCommands, setWebhook } from './telegram/api';
import { listDocuments, countDocuments } from './db/repo';
import { listPersonas } from './db/repo';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(env, req) });

    // ---- Telegram webhook: answer 200 instantly, do the work afterwards.
    if (path === '/telegram/webhook' || path === '/telegram/webhook/') {
      if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (!verifyTelegramSecret(env, req)) return new Response('forbidden', { status: 403 });

      let update: TgUpdate;
      try {
        update = (await req.json()) as TgUpdate;
      } catch {
        return new Response('bad json', { status: 400 });
      }

      ctx.waitUntil(
        (async () => {
          try {
            const c = await createCtx(env);
            await handleUpdate(c, update);
          } catch (e) {
            console.error('update failed', e);
          }
        })(),
      );
      return new Response('ok');
    }

    // ---- Internal endpoints for GitHub Actions
    if (path.startsWith('/internal/')) {
      if (!(await verifyInternalToken(env, req))) return errorResponse('forbidden', 403);

      let c: Ctx;
      try {
        c = await createCtx(env);
      } catch (e) {
        return errorResponse(e instanceof Error ? e.message : 'context failed', 500);
      }

      try {
        if (path === '/internal/scout') {
          const body = req.method === 'POST' ? ((await req.json()) as Record<string, unknown>) : {};
          const personaIds = Array.isArray(body.persona_ids) ? (body.persona_ids as string[]) : undefined;
          const report = await runScout(c, {
            personaIds,
            query: typeof body.query === 'string' ? body.query : undefined,
            trigger: 'cron',
            maxDocs: typeof body.max_docs === 'number' ? body.max_docs : undefined,
          });
          return jsonResponse({ ok: true, report });
        }

        if (path === '/internal/daily') {
          const result = await runDailyDigest(c);
          return jsonResponse({ ok: true, result });
        }

        if (path === '/internal/personas' && req.method === 'GET') {
          const personas = await listPersonas(c);
          return jsonResponse({
            ok: true,
            personas: personas.map((p) => ({ id: p.id, enabled: p.enabled, display_name: p.display_name })),
          });
        }

        if (path === '/internal/seed') {
          const body = req.method === 'POST' ? ((await req.json()) as Record<string, unknown>) : {};
          const result = await syncSeedPersonas(c, { force: body.force === true });
          return jsonResponse({ ok: true, result });
        }

        if (path === '/internal/ingest') {
          const body = (await req.json()) as {
            persona_id?: string;
            docs?: { url: string; title: string; content: string; publishedAt?: string | null; kind?: string; meta?: Record<string, unknown> }[];
          };
          if (!body.persona_id || !Array.isArray(body.docs)) return errorResponse('persona_id and docs required');
          const result = await ingestExternalDocs(
            c,
            body.persona_id,
            body.docs.map((d) => ({
              url: d.url,
              title: d.title,
              content: d.content,
              publishedAt: d.publishedAt ?? null,
              kind: 'youtube',
              meta: d.meta ?? {},
            })),
            'yt-transcripts',
          );
          return jsonResponse({ ok: true, result });
        }

        if (path === '/internal/snapshot' && req.method === 'GET') {
          const personas = await listPersonas(c);
          const docs = await Promise.all(
            personas.map(async (p) => ({
              persona_id: p.id,
              documents: await listDocuments(c, { personaId: p.id, limit: 200 }),
              count: await countDocuments(c, p.id),
            })),
          );
          return jsonResponse({ ok: true, generated_at: new Date().toISOString(), personas, documents: docs });
        }

        if (path === '/internal/drain') {
          const result = await drainQueue(c, 5);
          return jsonResponse({ ok: true, result });
        }

        if (path === '/internal/telegram-setup' && req.method === 'POST') {
          const body = (await req.json()) as { webhook_url?: string };
          const base = (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
          const webhook = body.webhook_url ?? `${base}/telegram/webhook`;
          if (!webhook.startsWith('https://')) return errorResponse('webhook_url must be https');
          await setMyCommands(env);
          await setChatMenuButton(env, `${base}/app`);
          const info = await setWebhook(env, webhook, env.TELEGRAM_WEBHOOK_SECRET);
          return jsonResponse({ ok: true, webhook, info, menu: `${base}/app` });
        }

        if (path === '/internal/webhook-info') {
          return jsonResponse({ ok: true, info: await getWebhookInfo(env) });
        }

        return errorResponse('unknown internal endpoint', 404);
      } catch (e) {
        return errorResponse(e instanceof Error ? e.message : 'internal error', 500);
      }
    }

    // ---- Mini App REST API
    if (path.startsWith('/api/')) {
      let c: Ctx;
      try {
        c = await createCtx(env);
      } catch (e) {
        return errorResponse(e instanceof Error ? e.message : 'context failed', 500, corsHeaders(env, req));
      }
      const res = await handleApi(c, req, url);
      for (const [k, v] of Object.entries(corsHeaders(env, req))) res.headers.set(k, v);
      return res;
    }

    // ---- Health
    if (path === '/health') {
      try {
        const c = await createCtx(env);
        return jsonResponse({
          ok: true,
          db: 'ok',
          personas: (await listPersonas(c)).length,
          models: c.models,
          now: new Date().toISOString(),
        });
      } catch (e) {
        return jsonResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
      }
    }

    // ---- Mini App (static assets served by this same Worker)
    if (path === '/' || path === '/app' || path === '/app/') {
      return assetOrFallback(env, req, url, 'index.html');
    }

    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(req);
      if (res.status !== 404) return res;
      return assetOrFallback(env, req, url, 'index.html');
    }

    return new Response('Not found', { status: 404 });
  },

  /**
   * Every minute: drain queued work (debates, Scout, digests). This is what makes
   * multi-LLM-call jobs reliable on the free tier — the webhook returns instantly
   * and any stage that got cut off is resumed here.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        try {
          const c = await createCtx(env);
          const result = await drainQueue(c, 3);
          if (result.processed) console.log('cron drained', result);
        } catch (e) {
          console.error('cron failed', e);
        }
      })(),
    );
  },
};

async function assetOrFallback(env: Env, req: Request, url: URL, file: string): Promise<Response> {
  if (env.ASSETS) {
    try {
      const assetUrl = new URL(url.toString());
      assetUrl.pathname = `/${file}`;
      const res = await env.ASSETS.fetch(new Request(assetUrl.toString(), req));
      if (res.status !== 404) return res;
    } catch {
      // fall through
    }
  }
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Council</title>
     <body style="font-family:system-ui;background:#0b0f14;color:#e6edf3;padding:32px;line-height:1.6">
     <h1>Council</h1>
     <p>The Mini App bundle is not built yet.</p>
     <pre>npm run web:build</pre>
     <p>Then redeploy. The bot itself works without the Mini App.</p>
     </body>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function corsHeaders(env: Env, req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = (env.MINIAPP_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const sameOrigin = origin && new URL(req.url).origin === origin;
  const allow = sameOrigin || !allowed.length ? origin || '*' : allowed.includes(origin) ? origin : '';
  if (!allow) return {};
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-headers': 'content-type,x-telegram-init-data,x-internal-token',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

export type { Ctx };
