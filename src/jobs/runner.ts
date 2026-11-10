import type { Ctx, JobRow } from '../types';
import {
  claimNextRun,
  claimRunById,
  enqueueRun,
  finishRun,
  getDebate,
  listMessages,
} from '../db/repo';
import { executeDebate, executeExtraRound, executeUserTurn, finishDebateSession } from '../agents/debate';
import { runChatTurn } from '../agents/chat';
import { runScout, runDailyDigest } from '../agents/scout';
import { runDig } from '../agents/dig';
import { buildNotebookPack } from '../agents/notebook';
import { draftPersona } from '../agents/personaDraft';
import { sendMessage, sendDocument } from '../telegram/api';
import { escapeHtml } from '../util/text';

export type JobKind =
  | 'debate'
  | 'chat'
  | 'user_turn'
  | 'extra_round'
  | 'end_thread'
  | 'scout'
  | 'daily'
  | 'dig'
  | 'notebook'
  | 'persona_draft';

/** Queue a unit of work and return immediately. The cron drainer picks it up. */
export async function enqueue(
  ctx: Ctx,
  kind: JobKind,
  payload: Record<string, unknown>,
  dedupeKey?: string,
): Promise<JobRow> {
  return enqueueRun(ctx, kind, payload, dedupeKey);
}

/** Process up to `limit` queued jobs. Used by the every-minute cron and inline fast paths. */
export async function drainQueue(ctx: Ctx, limit = 3): Promise<{ processed: number; errors: number }> {
  const jobs = await claimNextRun(ctx, undefined, limit);
  let processed = 0;
  let errors = 0;
  for (const job of jobs) {
    const outcome = await executeJob(ctx, job);
    processed++;
    if (!outcome.ok) errors++;
  }
  return { processed, errors };
}

/** Run a specific job inline (after enqueue) so the user does not wait for the cron tick. */
export async function runJobInline(ctx: Ctx, jobId: string): Promise<void> {
  const job = await claimRunById(ctx, jobId);
  if (!job) return;
  await executeJob(ctx, job);
}

interface JobOutcome {
  ok: boolean;
  error?: string;
  model?: string | null;
  result?: Record<string, unknown>;
}

async function executeJob(ctx: Ctx, job: JobRow): Promise<JobOutcome> {
  try {
    const outcome = await dispatch(ctx, job);
    await finishRun(ctx, job.id, {
      status: 'done',
      result: outcome.result ?? {},
      model: outcome.model ?? null,
    });
    return { ...outcome, ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500);
    console.error(`job ${job.kind}:${job.id} failed`, message);

    if (job.attempts < 3) {
      await finishRun(ctx, job.id, { status: 'queued', error: message });
      return { ok: false, error: message };
    }

    await finishRun(ctx, job.id, { status: 'error', error: message });
    await notifyFailure(ctx, job, message);
    return { ok: false, error: message };
  }
}

async function dispatch(ctx: Ctx, job: JobRow): Promise<JobOutcome> {
  switch (job.kind as JobKind) {
    case 'debate': {
      const debate = await getDebate(ctx, String(job.payload.debate_id ?? ''));
      if (!debate) throw new Error('Debate not found');
      const res = await executeDebate(ctx, debate);
      return { ok: true, model: res.model, result: { stage: res.stage, requests: res.requests } };
    }

    case 'extra_round': {
      const debate = await getDebate(ctx, String(job.payload.debate_id ?? ''));
      if (!debate) throw new Error('Debate not found');
      const res = await executeExtraRound(ctx, debate);
      return { ok: true, model: res.model, result: { requests: res.requests } };
    }

    case 'end_thread': {
      const debate = await getDebate(ctx, String(job.payload.debate_id ?? ''));
      if (!debate) throw new Error('Debate not found');
      const res = await finishDebateSession(ctx, debate);
      return { ok: true, model: null, result: { requests: res.requests } };
    }

    case 'user_turn': {
      const debate = await getDebate(ctx, String(job.payload.debate_id ?? ''));
      if (!debate) throw new Error('Debate not found');
      const res = await executeUserTurn(ctx, debate, String(job.payload.text ?? ''));
      return { ok: true, model: res.model, result: { requests: res.requests } };
    }

    case 'chat': {
      const res = await runChatTurn(ctx, {
        chatId: Number(job.payload.chat_id),
        userId: Number(job.payload.user_id),
        personaId: String(job.payload.persona_id ?? ''),
        text: String(job.payload.text ?? ''),
      });
      return { ok: true, model: res.model, result: { debate_id: res.debateId } };
    }

    case 'scout': {
      const report = await runScout(ctx, {
        personaIds: Array.isArray(job.payload.persona_ids) ? (job.payload.persona_ids as string[]) : undefined,
        query: job.payload.query ? String(job.payload.query) : undefined,
        trigger: 'manual',
      });
      return { ok: true, model: null, result: report as unknown as Record<string, unknown> };
    }

    case 'daily': {
      const digest = await runDailyDigest(ctx);
      return { ok: true, model: null, result: digest as unknown as Record<string, unknown> };
    }

    case 'dig': {
      const res = await runDig(ctx, {
        raw: String(job.payload.raw ?? ''),
        chatId: job.payload.chat_id == null ? null : Number(job.payload.chat_id),
        userId: job.payload.user_id == null ? null : Number(job.payload.user_id),
      });
      return { ok: true, model: null, result: { debate_id: res.debate.id, query: res.query } };
    }

    case 'notebook': {
      const debate = await getDebate(ctx, String(job.payload.debate_id ?? ''));
      if (!debate) throw new Error('Debate not found');
      const pack = await buildNotebookPack(ctx, debate);
      if (!pack) throw new Error('No persona messages in that debate yet.');
      const chatId = Number(job.payload.chat_id ?? 0);
      if (chatId) {
        await sendDocument(ctx.env, chatId, pack.filename, pack.markdown, `📓 ${pack.caption}`);
        await sendDocument(ctx.env, chatId, 'sources.txt', pack.sourcesTxt, '🔗 sources.txt');
        if (pack.driveUrl) {
          await sendMessage(ctx.env, chatId, `📗 Google Doc: ${pack.driveUrl}`);
        }
      }
      return { ok: true, model: null, result: { filename: pack.filename, drive: pack.driveUrl ?? null } };
    }

    case 'persona_draft': {
      const draft = await draftPersona(
        ctx,
        String(job.payload.name ?? ''),
        job.payload.hint ? String(job.payload.hint) : undefined,
      );
      const chatId = job.payload.chat_id;
      if (chatId != null) {
        await sendMessage(
          ctx.env,
          Number(chatId),
          [
            `🧪 <b>Draft persona</b> — <code>${escapeHtml(draft.personaId)}</code>`,
            'Review and approve it in the Mini App → Personas → Drafts.',
            '',
            `<pre>${escapeHtml(draft.yaml.slice(0, 2500))}</pre>`,
          ].join('\n'),
        );
      }
      return { ok: true, model: null, result: { draft_id: draft.draftId, persona_id: draft.personaId } };
    }

    default:
      throw new Error(`Unknown job kind: ${job.kind}`);
  }
}

async function notifyFailure(ctx: Ctx, job: JobRow, message: string): Promise<void> {
  const chatId = Number(job.payload.chat_id ?? 0);
  if (!chatId) return;
  try {
    const hint = /429|quota|rate/i.test(message)
      ? 'The free model quota looks exhausted. /status shows what is left.'
      : message;
    await sendMessage(ctx.env, chatId, `⚠️ <b>Job failed</b> (${escapeHtml(job.kind)})\n${escapeHtml(hint)}`);
  } catch {
    // nothing else to do
  }
}

/** Convenience for the /notebook command. */
export async function debateMessages(ctx: Ctx, debateId: string) {
  return listMessages(ctx, debateId);
}
