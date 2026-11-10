import type { Ctx, PersonaRow } from '../types';
import { jsonResponse, errorResponse } from '../config';
import { authenticate } from './auth';
import {
  allBeliefs,
  countBeliefs,
  countDocuments,
  createDebate,
  getDebate,
  getDraft,
  getPersona,
  listDebates,
  listDocuments,
  listDrafts,
  listHashtags,
  listMessages,
  listPersonas,
  listSources,
  queuedCount,
  setDraftStatus,
  setPersonaEnabled,
  setSetting,
  upsertPersona,
} from '../db/repo';
import { personaToYaml, parsePersonaYaml, normalizeId } from '../personas/loader';
import { buildNotebookPack } from '../agents/notebook';
import { getQuota, formatQuota } from '../llm/quota';
import { enqueue } from '../jobs/runner';
import { lastSuccessfulModel } from '../db/repo';
import { responseLanguage } from '../util/safety';

/**
 * REST surface for the Mini App. Every request must carry Telegram initData;
 * the app never talks to D1 directly.
 */
export async function handleApi(ctx: Ctx, req: Request, url: URL): Promise<Response> {
  const auth = await authenticate(ctx.env, req);
  if (!auth.ok) return errorResponse(auth.error ?? 'unauthorized', 401);

  const path = url.pathname.replace(/^\/api/, '') || '/';
  const method = req.method.toUpperCase();

  try {
    // ---------- bootstrap
    if (path === '/bootstrap' && method === 'GET') {
      const personas = await listPersonas(ctx);
      const quota = await getQuota(ctx);
      const counts = await Promise.all(
        personas.map(async (p) => ({
          id: p.id,
          documents: await countDocuments(ctx, p.id),
          beliefs: await countBeliefs(ctx, p.id),
        })),
      );
      return jsonResponse({
        ok: true,
        settings: ctx.settings,
        models: ctx.models,
        lastModel: await lastSuccessfulModel(ctx),
        quota: { ...quota, formatted: formatQuota(quota) },
        queue: await queuedCount(ctx),
        personas: personas.map((p) => ({ ...publicPersona(p), documents: counts.find((c) => c.id === p.id)?.documents ?? 0, beliefs: counts.find((c) => c.id === p.id)?.beliefs ?? 0 })),
        drafts: await listDrafts(ctx),
      });
    }

    // ---------- debates
    if (path === '/debates' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 20);
      const debates = await listDebates(ctx, { limit });
      return jsonResponse({ ok: true, debates: debates.map(publicDebate) });
    }

    if (path === '/debates' && method === 'POST') {
      const body = (await req.json()) as { question?: string; personas?: string[] };
      const question = (body.question ?? '').trim().slice(0, 800);
      if (!question) return errorResponse('question is required');
      const personas = (await listPersonas(ctx, { enabledOnly: true })).filter(
        (p) => !body.personas?.length || body.personas.includes(p.id),
      );
      if (!personas.length) return errorResponse('no personas enabled');
      const debate = await createDebate(ctx, {
        chat_id: null,
        user_id: auth.userId,
        question,
        lang: responseLanguage(question, ctx.settings),
        mode: 'council',
        persona_ids: personas.map((p) => p.id),
      });
      const job = await enqueue(ctx, 'debate', { debate_id: debate.id }, `debate:${debate.id}`);
      return jsonResponse({ ok: true, debate: publicDebate(debate), job_id: job.id }, 202);
    }

    const debateMatch = path.match(/^\/debates\/([^/]+)$/);
    if (debateMatch && method === 'GET') {
      const debate = await getDebate(ctx, debateMatch[1]);
      if (!debate) return errorResponse('not found', 404);
      const messages = await listMessages(ctx, debate.id);
      return jsonResponse({
        ok: true,
        debate: publicDebate(debate),
        scribe: debate.scribe ?? debate.state.scribe ?? null,
        messages: messages.map((m) => ({
          id: m.id,
          persona_id: m.persona_id,
          round: m.round,
          role: m.role,
          answer: m.answer,
          body: m.body,
          citations: m.citations,
          inference: m.inference,
          created_at: m.created_at,
        })),
      });
    }

    const moreMatch = path.match(/^\/debates\/([^/]+)\/(more|me|notebook|end)$/);
    if (moreMatch && method === 'GET' && moreMatch[2] === 'notebook') {
      const debate = await getDebate(ctx, moreMatch[1]);
      if (!debate) return errorResponse('not found', 404);
      const pack = await buildNotebookPack(ctx, debate, { upload: false });
      if (!pack) return errorResponse('no persona messages yet', 409);
      return jsonResponse({ ok: true, filename: pack.filename, markdown: pack.markdown, sources: pack.sourcesTxt });
    }

    if (moreMatch && method === 'POST') {
      const debate = await getDebate(ctx, moreMatch[1]);
      if (!debate) return errorResponse('not found', 404);
      const action = moreMatch[2];
      if (action === 'more') {
        const job = await enqueue(ctx, 'extra_round', { debate_id: debate.id });
        return jsonResponse({ ok: true, job_id: job.id }, 202);
      }
      if (action === 'notebook') {
        const job = await enqueue(ctx, 'notebook', { debate_id: debate.id, chat_id: debate.chat_id ?? 0 });
        return jsonResponse({ ok: true, job_id: job.id }, 202);
      }
      if (action === 'end') {
        const job = await enqueue(ctx, 'end_thread', { debate_id: debate.id, chat_id: debate.chat_id ?? 0 });
        return jsonResponse({ ok: true, job_id: job.id }, 202);
      }
      const body = (await req.json()) as { text?: string };
      const text = (body.text ?? '').trim();
      if (!text) return errorResponse('text is required');
      const job = await enqueue(ctx, 'user_turn', { debate_id: debate.id, text, chat_id: debate.chat_id ?? 0 });
      return jsonResponse({ ok: true, job_id: job.id }, 202);
    }

    // ---------- personas
    if (path === '/personas' && method === 'GET') {
      const personas = await listPersonas(ctx);
      return jsonResponse({ ok: true, personas: personas.map(publicPersona) });
    }

    if (path === '/personas' && method === 'POST') {
      const body = (await req.json()) as { yaml?: string; persona?: Partial<PersonaRow> };
      if (!body.yaml) return errorResponse('yaml is required');
      const parsed = parsePersonaYaml(body.yaml, body.persona?.id);
      const saved = await upsertPersona(ctx, parsed, body.yaml, 'imported');
      return jsonResponse({ ok: true, persona: publicPersona(saved) });
    }

    if (path === '/personas/import' && method === 'POST') {
      const body = (await req.json()) as { yaml?: string };
      if (!body.yaml) return errorResponse('yaml is required');
      const parsed = parsePersonaYaml(body.yaml);
      const existing = await getPersona(ctx, parsed.id);
      const saved = await upsertPersona(ctx, parsed, body.yaml, 'imported');
      return jsonResponse({ ok: true, persona: publicPersona(saved), updated: !!existing });
    }

    const personaMatch = path.match(/^\/personas\/([^/]+)$/);
    if (personaMatch && method === 'GET') {
      const persona = await getPersona(ctx, personaMatch[1]);
      if (!persona) return errorResponse('not found', 404);
      return jsonResponse({ ok: true, persona: publicPersona(persona), yaml: personaToYaml(persona) });
    }

    if (personaMatch && method === 'PATCH') {
      const body = (await req.json()) as { enabled?: boolean; yaml?: string };
      const persona = await getPersona(ctx, personaMatch[1]);
      if (!persona) return errorResponse('not found', 404);
      if (typeof body.enabled === 'boolean') await setPersonaEnabled(ctx, persona.id, body.enabled);
      if (body.yaml) {
        const parsed = parsePersonaYaml(body.yaml, persona.id);
        if (parsed.id !== persona.id) return errorResponse('id in YAML must match the URL id');
        await upsertPersona(ctx, parsed, body.yaml, persona.origin === 'seed' ? 'imported' : persona.origin);
      }
      const updated = await getPersona(ctx, persona.id);
      return jsonResponse({ ok: true, persona: updated ? publicPersona(updated) : null });
    }

    if (personaMatch && method === 'DELETE') {
      const persona = await getPersona(ctx, personaMatch[1]);
      if (!persona) return errorResponse('not found', 404);
      await setPersonaEnabled(ctx, persona.id, false);
      return jsonResponse({ ok: true, disabled: persona.id });
    }

    const cloneMatch = path.match(/^\/personas\/([^/]+)\/clone$/);
    if (cloneMatch && method === 'POST') {
      const body = (await req.json()) as { new_id?: string };
      const source = await getPersona(ctx, cloneMatch[1]);
      if (!source) return errorResponse('not found', 404);
      const newId = normalizeId(body.new_id ?? `${source.id}_copy`);
      if (!newId) return errorResponse('invalid new_id');
      if (await getPersona(ctx, newId)) return errorResponse('id already exists', 409);
      const parsed = parsePersonaYaml(personaToYaml(source), newId);
      parsed.id = newId;
      parsed.display_name = `${source.display_name.replace(/\s*\(clone\)$/i, '')} (clone)`;
      const saved = await upsertPersona(ctx, parsed, personaToYaml(parsed), 'clone');
      return jsonResponse({ ok: true, persona: publicPersona(saved) });
    }

    const beliefsMatch = path.match(/^\/personas\/([^/]+)\/beliefs$/);
    if (beliefsMatch && method === 'GET') {
      const persona = await getPersona(ctx, beliefsMatch[1]);
      if (!persona) return errorResponse('not found', 404);
      const topic = (url.searchParams.get('topic') ?? '').toLowerCase();
      const beliefs = await allBeliefs(ctx, persona.id, { topic: topic || undefined, limit: 400 });
      const grouped = new Map<string, typeof beliefs>();
      for (const b of beliefs) {
        const list = grouped.get(b.topic_key) ?? [];
        list.push(b);
        grouped.set(b.topic_key, list);
      }
      return jsonResponse({
        ok: true,
        topics: [...grouped.entries()].map(([key, list]) => ({
          topic_key: key,
          topic: list[0]?.topic ?? key,
          current: list.find((b) => !b.superseded_at) ?? null,
          history: list.filter((b) => b.superseded_at),
        })),
      });
    }

    // ---------- sources
    if (path === '/sources' && method === 'GET') {
      const personaId = url.searchParams.get('persona') ?? undefined;
      const since = url.searchParams.get('since') ?? undefined;
      const limit = Number(url.searchParams.get('limit') ?? 40);
      const [docs, feeds] = await Promise.all([listDocuments(ctx, { personaId, since, limit }), listSources(ctx, personaId)]);
      return jsonResponse({
        ok: true,
        feeds: feeds.map((f) => ({ id: f.id, persona_id: f.persona_id, kind: f.kind, label: f.label, url: f.url, query: f.query })),
        documents: docs,
      });
    }

    // ---------- hashtags
    if (path === '/hashtags' && method === 'GET') {
      return jsonResponse({ ok: true, hashtags: await listHashtags(ctx, 40) });
    }

    if (path === '/dig' && method === 'POST') {
      const body = (await req.json()) as { raw?: string };
      const raw = (body.raw ?? '').trim();
      if (!raw) return errorResponse('raw is required');
      const job = await enqueue(ctx, 'dig', { raw, chat_id: null, user_id: auth.userId });
      return jsonResponse({ ok: true, job_id: job.id }, 202);
    }

    // ---------- drafts
    if (path === '/drafts' && method === 'GET') {
      return jsonResponse({ ok: true, drafts: await listDrafts(ctx) });
    }

    const draftMatch = path.match(/^\/drafts\/([^/]+)\/(approve|reject)$/);
    if (draftMatch && method === 'POST') {
      const draft = await getDraft(ctx, draftMatch[1]);
      if (!draft) return errorResponse('not found', 404);
      if (draftMatch[2] === 'reject') {
        await setDraftStatus(ctx, draft.id, 'rejected');
        return jsonResponse({ ok: true, rejected: draft.id });
      }
      const parsed = parsePersonaYaml(draft.yaml, draft.persona_id);
      const saved = await upsertPersona(ctx, parsed, draft.yaml, 'draft');
      await setDraftStatus(ctx, draft.id, 'approved');
      return jsonResponse({ ok: true, persona: publicPersona(saved) });
    }

    // ---------- settings
    if (path === '/settings' && method === 'GET') {
      return jsonResponse({ ok: true, settings: ctx.settings, models: ctx.models });
    }

    if (path === '/settings' && method === 'PUT') {
      const body = (await req.json()) as Record<string, unknown>;
      if (body.recency_half_life_days != null) {
        const v = Number(body.recency_half_life_days);
        if (v < 1 || v > 3650) return errorResponse('recency_half_life_days must be 1..3650');
        await setSetting(ctx, 'recency_half_life_days', v);
      }
      if (body.rounds != null) {
        const v = Number(body.rounds);
        if (v < 1 || v > 4) return errorResponse('rounds must be 1..4');
        await setSetting(ctx, 'rounds', v);
      }
      if (body.persona_word_limit != null) {
        const v = Number(body.persona_word_limit);
        if (v < 40 || v > 400) return errorResponse('persona_word_limit must be 40..400');
        await setSetting(ctx, 'persona_word_limit', v);
      }
      if (body.language != null) {
        const v = String(body.language);
        if (!['auto', 'en', 'ar'].includes(v)) return errorResponse('language must be auto|en|ar');
        await setSetting(ctx, 'language', v);
      }
      if (body.models_override !== undefined) {
        const v = body.models_override == null ? null : String(body.models_override);
        await setSetting(ctx, 'models_override', v);
      }
      if (body.parallel_round1 != null) {
        await setSetting(ctx, 'parallel_round1', body.parallel_round1 === true || body.parallel_round1 === 'true');
      }
      if (body.max_docs_per_scout_run != null) {
        const v = Number(body.max_docs_per_scout_run);
        if (v < 1 || v > 20) return errorResponse('max_docs_per_scout_run must be 1..20');
        await setSetting(ctx, 'max_docs_per_scout_run', v);
      }
      return jsonResponse({ ok: true });
    }

    if (path === '/health' && method === 'GET') {
      return jsonResponse({ ok: true, settings: ctx.settings, models: ctx.models });
    }

    return errorResponse(`No route for ${method} ${path}`, 404);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return errorResponse(message, 500);
  }
}

function publicPersona(p: PersonaRow) {
  return {
    id: p.id,
    display_name: p.display_name,
    emoji: p.emoji,
    bio: p.bio,
    speaking_style: p.speaking_style,
    core_values: p.core_values,
    known_biases: p.known_biases,
    topics_of_expertise: p.topics_of_expertise,
    source_feeds: p.source_feeds,
    model_override: p.model_override,
    enabled: p.enabled,
    origin: p.origin,
    updated_at: p.updated_at,
  };
}

function publicDebate(d: {
  id: string;
  question: string;
  lang: string;
  mode: string;
  persona_ids: string[];
  status: string;
  stage: string;
  hashtags: string[];
  created_at: string;
  finished_at: string | null;
}) {
  return {
    id: d.id,
    question: d.question,
    lang: d.lang,
    mode: d.mode,
    persona_ids: d.persona_ids,
    status: d.status,
    stage: d.stage,
    hashtags: d.hashtags,
    created_at: d.created_at,
    finished_at: d.finished_at,
  };
}
