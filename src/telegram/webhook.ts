import type { Ctx, DebateRow, PersonaRow } from '../types';
import {
  allBeliefs,
  countBeliefs,
  createDebate,
  getDebate,
  getPersona,
  getSetting,
  listDebates,
  listPersonas,
  queuedCount,
  setPersonaEnabled,
  setSetting,
  upsertPersona,
} from '../db/repo';
import { enqueue, runJobInline } from '../jobs/runner';
import { editMessage, sendDocument, sendMessage, downloadFile } from './api';
import { escapeHtml, truncate } from '../util/text';
import { isAllowedUser } from './guard';
import { hasQuotaFor, formatQuota, getQuota } from '../llm/quota';
import { parsePersonaYaml, personaToYaml, normalizeId } from '../personas/loader';
import { runScout, scoutStatus } from '../agents/scout';
import { responseLanguage } from '../util/safety';
import { lastSuccessfulModel } from '../db/repo';

interface TgUser {
  id: number;
  first_name?: string;
  username?: string;
}

interface TgDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: { id: number; type: string };
  text?: string;
  caption?: string;
  document?: TgDocument;
  reply_to_message?: TgMessage;
}

interface TgCallback {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
  edited_message?: TgMessage;
}

type ChatMode = { mode: 'council' } | { mode: 'chat'; persona_id: string };

/** A thread counts as live for this long after it finishes. */
const THREAD_TTL_MS = 90 * 60_000;
/** Pre-flight Scout refresh at most this often per chat. */
const PREFLIGHT_TTL_MS = 30 * 60_000;

/** Entry point. Caller must have already returned 200 to Telegram. */
export async function handleUpdate(ctx: Ctx, update: TgUpdate): Promise<void> {
  if (update.edited_message) return; // ignore edits, never double-answer

  const msg = update.message;
  const cb = update.callback_query;

  if (cb) {
    if (!isAllowedUser(ctx.env, cb.from.id)) return;
    try {
      const { answerCallbackQuery } = await import('./api');
      await answerCallbackQuery(ctx.env, cb.id);
    } catch {
      // cosmetic
    }
    return;
  }

  if (!msg?.from) return;
  if (!isAllowedUser(ctx.env, msg.from.id)) {
    // Hard rule: silently ignore everyone else.
    return;
  }

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  try {
    if (msg.document) {
      await handleDocument(ctx, msg, chatId);
      return;
    }

    const text = (msg.text ?? '').trim();
    if (!text) return;

    if (text.startsWith('/')) {
      await handleCommand(ctx, msg, text, chatId, userId);
      return;
    }

    const mode = await getChatMode(ctx, chatId);
    if (mode.mode === 'chat' && mode.persona_id) {
      const persona = await getPersona(ctx, mode.persona_id);
      if (persona?.enabled) {
        const job = await enqueue(ctx, 'chat', {
          chat_id: chatId,
          user_id: userId,
          persona_id: persona.id,
          text: text.slice(0, 2000),
        });
        await runJobInline(ctx, job.id);
        return;
      }
      await setSetting(ctx, `chatmode:${chatId}`, { mode: 'council' });
    }

    // Council mode: keep talking in the same thread if it is still live.
    const live = await findLiveThread(ctx, chatId);
    if (live) {
      await continueThread(ctx, live, chatId, text);
      return;
    }

    await startCouncil(ctx, chatId, userId, text);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await sendMessage(ctx.env, chatId, `⚠️ ${escapeHtml(message.slice(0, 500))}`).catch(() => {});
  }
}

// ---------------------------------------------------------------- commands

async function handleCommand(
  ctx: Ctx,
  msg: TgMessage,
  text: string,
  chatId: number,
  userId: number,
): Promise<void> {
  const parts = text.split(/\s+/);
  const cmd = (parts[0] ?? '').toLowerCase().replace(/@[\w_]+$/, '');
  const arg = text.slice(parts[0].length).trim();

  switch (cmd) {
    case '/start':
    case '/help':
      await sendMessage(ctx.env, chatId, helpText());
      return;

    case '/ask': {
      if (!arg) {
        await sendMessage(ctx.env, chatId, 'Usage: <code>/ask your question</code>');
        return;
      }
      await setSetting(ctx, `chatmode:${chatId}`, { mode: 'council' });
      await startCouncil(ctx, chatId, userId, arg);
      return;
    }

    case '/new': {
      await setSetting(ctx, `fresh:${chatId}`, Date.now());
      await setSetting(ctx, `chatmode:${chatId}`, { mode: 'council' });
      await sendMessage(ctx.env, chatId, '🆕 <b>New thread.</b> Ask anything — Scout will refresh the personas first.');
      return;
    }

    case '/end':
    case '/summary': {
      const live = (await listDebates(ctx, { limit: 1, chatId }))[0];
      if (!live) {
        await sendMessage(ctx.env, chatId, 'Nothing to close yet.');
        return;
      }
      await sendMessage(ctx.env, chatId, '📝 <b>Scribe</b> is writing the final summary…');
      const job = await enqueue(ctx, 'end_thread', { debate_id: live.id, chat_id: chatId });
      await runJobInline(ctx, job.id);
      await setSetting(ctx, `fresh:${chatId}`, Date.now());
      return;
    }

    case '/council':
      await setSetting(ctx, `chatmode:${chatId}`, { mode: 'council' });
      await sendMessage(
        ctx.env,
        chatId,
        '👥 <b>Council mode</b> — send any question. Follow-up messages continue the same thread; /new starts over.',
      );
      return;

    case '/chat': {
      if (!arg) {
        const personas = await listPersonas(ctx, { enabledOnly: true });
        await sendMessage(
          ctx.env,
          chatId,
          [
            'Usage: <code>/chat elon</code>',
            '',
            ...personas.map((p) => `${p.emoji} <code>${p.id}</code> — ${escapeHtml(p.display_name)}`),
          ].join('\n'),
        );
        return;
      }
      const personas = await listPersonas(ctx, { enabledOnly: true });
      const persona = findPersona(personas, arg);
      if (!persona) {
        await sendMessage(ctx.env, chatId, `No persona matches “${escapeHtml(arg)}”. Try /personas.`);
        return;
      }
      await setSetting(ctx, `chatmode:${chatId}`, { mode: 'chat', persona_id: persona.id });
      await sendMessage(
        ctx.env,
        chatId,
        `${persona.emoji} <b>${escapeHtml(persona.display_name)}</b> <i>· simulated</i>\nNow chatting 1:1. Send a message, or /council to return to the group.`,
      );
      return;
    }

    case '/personas':
      await listPersonasCommand(ctx, chatId);
      return;

    case '/persona':
      await personaCommand(ctx, chatId, arg);
      return;

    case '/update': {
      const personas = await listPersonas(ctx);
      const target = arg ? findPersona(personas, arg) : null;
      if (arg && !target) {
        await sendMessage(ctx.env, chatId, `No persona matches “${escapeHtml(arg)}”.`);
        return;
      }
      const job = await enqueue(
        ctx,
        'scout',
        { persona_ids: target ? [target.id] : undefined, chat_id: chatId },
        `scout:${target?.id ?? 'all'}:${new Date().toISOString().slice(0, 13)}`,
      );
      await sendMessage(
        ctx.env,
        chatId,
        `🔍 <b>Scout</b> is refreshing ${target ? escapeHtml(target.display_name) : 'all personas'}… this can take a minute.`,
      );
      await runJobInline(ctx, job.id);
      return;
    }

    case '/beliefs':
      await beliefsCommand(ctx, chatId, arg);
      return;

    case '/dig': {
      if (!arg) {
        await sendMessage(ctx.env, chatId, 'Usage: <code>/dig #saudi_mortgage_sama</code> or <code>/dig mortgage rates saudi</code>');
        return;
      }
      const job = await enqueue(ctx, 'dig', { raw: arg, chat_id: chatId, user_id: userId });
      await sendMessage(ctx.env, chatId, `🕳 <b>Scout</b> is digging into <b>${escapeHtml(arg)}</b>… then a quick debate.`);
      await runJobInline(ctx, job.id);
      return;
    }

    case '/notebook': {
      const debate = arg
        ? await getDebate(ctx, arg.trim())
        : (await listDebates(ctx, { limit: 1, chatId }))[0] ?? null;
      if (!debate) {
        await sendMessage(ctx.env, chatId, 'No debate found. Ask something first.');
        return;
      }
      const job = await enqueue(ctx, 'notebook', { debate_id: debate.id, chat_id: chatId });
      await sendMessage(ctx.env, chatId, `📓 Building the NotebookLM pack for <code>${escapeHtml(debate.id)}</code>…`);
      await runJobInline(ctx, job.id);
      return;
    }

    case '/more': {
      const debate = (await listDebates(ctx, { limit: 1, chatId }))[0];
      if (!debate) {
        await sendMessage(ctx.env, chatId, 'No debate to extend yet.');
        return;
      }
      const job = await enqueue(ctx, 'extra_round', { debate_id: debate.id, chat_id: chatId });
      await sendMessage(ctx.env, chatId, '🔁 One more round…');
      await runJobInline(ctx, job.id);
      return;
    }

    case '/me': {
      if (!arg) {
        await sendMessage(ctx.env, chatId, 'Usage: <code>/me your point</code>');
        return;
      }
      const debate = (await listDebates(ctx, { limit: 1, chatId }))[0];
      if (!debate) {
        await sendMessage(ctx.env, chatId, 'Start a debate first with /ask.');
        return;
      }
      await continueThread(ctx, debate, chatId, arg);
      return;
    }

    case '/status':
      await statusCommand(ctx, chatId);
      return;

    case '/menu':
    case '/settings':
      await sendMessage(ctx.env, chatId, settingsHint(ctx));
      return;

    default:
      await sendMessage(ctx.env, chatId, `Unknown command <code>${escapeHtml(cmd)}</code>. Try /help.`);
  }
}

// ---------------------------------------------------------------- /ask

async function startCouncil(ctx: Ctx, chatId: number, userId: number, question: string): Promise<void> {
  const q = question.trim().slice(0, 800);
  if (!q) return;

  const personas = await listPersonas(ctx, { enabledOnly: true });
  if (!personas.length) {
    await sendMessage(ctx.env, chatId, 'No enabled personas. Run the Setup/Seed action or /persona import.');
    return;
  }

  // Live mode: one call per persona. Batch mode: one call for all of them.
  const round1Calls = ctx.settings.parallel_round1 ? personas.length : 1;
  const round2Calls = ctx.settings.rounds >= 2 ? 1 : 0;
  const needed = round1Calls + round2Calls + 1;

  const quota = await hasQuotaFor(ctx, needed);
  if (!quota.ok) {
    await sendMessage(ctx.env, chatId, `⚠️ ${escapeHtml(quota.note)}\nTry again tomorrow, or /status.`);
    return;
  }

  // Scout refreshes the people before they speak.
  const refreshed = await preflight(ctx, chatId, personas);

  const lang = responseLanguage(q, ctx.settings);
  const debate = await createDebate(ctx, {
    chat_id: chatId,
    user_id: userId,
    question: q,
    lang,
    mode: 'council',
    persona_ids: personas.map((p) => p.id),
  });

  const status = await sendMessage(
    ctx.env,
    chatId,
    [
      `🧠 <b>Council</b> · ${personas.map((p) => `${p.emoji} ${escapeHtml(p.display_name)}`).join(' · ')}`,
      refreshed != null ? `<i>🔍 Scout added ${refreshed} new source(s) just now.</i>` : '',
      `<i>${escapeHtml(truncate(q, 200))}</i>`,
      '',
      ctx.settings.parallel_round1
        ? '<i>Round 1 — each persona is writing in parallel…</i>'
        : '<i>Round 1 — the council is writing…</i>',
    ]
      .filter(Boolean)
      .join('\n'),
  );

  const job = await enqueue(ctx, 'debate', { debate_id: debate.id, chat_id: chatId }, `debate:${debate.id}`);
  await runJobInline(ctx, job.id);

  if (status) {
    await editMessage(
      ctx.env,
      chatId,
      status,
      [
        `🧠 <b>Council</b> · ${personas.map((p) => p.emoji).join('')}`,
        `<i>${escapeHtml(truncate(q, 200))}</i>`,
        '',
        '<i>Round 1 → Round 2 → Scribe → 📓 pack.</i> Keep typing to stay in this thread, /end to close it.',
      ].join('\n'),
    );
  }
}

async function continueThread(ctx: Ctx, debate: DebateRow, chatId: number, text: string): Promise<void> {
  const job = await enqueue(ctx, 'user_turn', { debate_id: debate.id, chat_id: chatId, text: text.slice(0, 2000) });
  await sendMessage(ctx.env, chatId, '💬 <i>The council is reading that…</i>');
  await runJobInline(ctx, job.id);
}

/**
 * Quick Scout refresh with no LLM calls: headline feeds only, 2 docs per persona.
 * Returns the number of new documents, or null when it was skipped as too recent.
 */
async function preflight(ctx: Ctx, chatId: number, personas: PersonaRow[]): Promise<number | null> {
  const key = `preflight:${chatId}`;
  const last = await getSetting<number>(ctx, key);
  if (typeof last === 'number' && Date.now() - last < PREFLIGHT_TTL_MS) return null;

  const status = await sendMessage(
    ctx.env,
    chatId,
    `🔍 <b>Scout</b> · checking fresh sources for ${personas.map((p) => p.display_name.split(' ')[0]).join(', ')}…`,
  );

  try {
    const report = await runScout(ctx, {
      personaIds: personas.map((p) => p.id),
      trigger: 'manual',
      quick: true,
      extractBeliefs: false,
      maxDocs: 2,
    });
    const added = report.personas.reduce((sum, p) => sum + p.newDocs, 0);
    await setSetting(ctx, key, Date.now());
    if (status) {
      await editMessage(
        ctx.env,
        chatId,
        status,
        added
          ? `✅ <b>Scout</b> · ${added} new source(s) across ${personas.length} personas.`
          : `✅ <b>Scout</b> · no new sources since the last refresh.`,
      );
    }
    return added;
  } catch (e) {
    if (status) {
      await editMessage(ctx.env, chatId, status, `⚠️ <b>Scout</b> could not refresh just now — answering from stored sources.`);
    }
    console.error('preflight failed', e);
    return null;
  }
}

async function findLiveThread(ctx: Ctx, chatId: number): Promise<DebateRow | null> {
  const latest = (await listDebates(ctx, { limit: 1, chatId }))[0];
  if (!latest) return null;
  if (latest.status === 'error') return null;

  const freshAfter = await getSetting<number>(ctx, `fresh:${chatId}`);
  const created = Date.parse(latest.created_at);
  if (typeof freshAfter === 'number' && created < freshAfter) return null;

  const finished = latest.finished_at ? Date.parse(latest.finished_at) : Date.now();
  if (Date.now() - finished > THREAD_TTL_MS) return null;
  return latest;
}

// ---------------------------------------------------------------- personas

async function listPersonasCommand(ctx: Ctx, chatId: number): Promise<void> {
  const personas = await listPersonas(ctx);
  if (!personas.length) {
    await sendMessage(ctx.env, chatId, 'No personas yet. Run the Seed action, or /persona add <name>.');
    return;
  }
  const lines = ['👥 <b>Personas</b>', ''];
  for (const p of personas) {
    const count = await countBeliefs(ctx, p.id);
    lines.push(
      `${p.emoji} <code>${p.id}</code> — <b>${escapeHtml(p.display_name)}</b> ${p.enabled ? '🟢' : '⚪️'} · ${count} belief(s)${p.origin !== 'seed' ? ` · <i>${p.origin}</i>` : ''}`,
    );
  }
  lines.push('');
  lines.push('<i>/chat elon · /beliefs elon · /persona export elon</i>');
  await sendMessage(ctx.env, chatId, lines.join('\n'));
}

async function personaCommand(ctx: Ctx, chatId: number, arg: string): Promise<void> {
  const [sub, ...rest] = arg.split(/\s+/).filter(Boolean);
  const action = (sub ?? '').toLowerCase();

  if (!action || action === 'list') {
    await listPersonasCommand(ctx, chatId);
    return;
  }

  if (action === 'add') {
    const name = rest.join(' ').trim();
    if (!name) {
      await sendMessage(ctx.env, chatId, 'Usage: <code>/persona add Sarah Connor</code>');
      return;
    }
    const job = await enqueue(ctx, 'persona_draft', { name, chat_id: chatId });
    await sendMessage(ctx.env, chatId, `🧪 <b>Scout</b> is drafting <b>${escapeHtml(name)}</b> from a news sweep…`);
    await runJobInline(ctx, job.id);
    return;
  }

  if (action === 'clone') {
    const [fromId, toId] = rest;
    if (!fromId || !toId) {
      await sendMessage(ctx.env, chatId, 'Usage: <code>/persona clone elon elon_2020</code>');
      return;
    }
    const source = await getPersona(ctx, fromId);
    if (!source) {
      await sendMessage(ctx.env, chatId, `No persona <code>${escapeHtml(fromId)}</code>.`);
      return;
    }
    const newId = normalizeId(toId);
    if (!newId) {
      await sendMessage(ctx.env, chatId, 'New id must be lowercase letters, numbers or underscores.');
      return;
    }
    if (await getPersona(ctx, newId)) {
      await sendMessage(ctx.env, chatId, `Persona <code>${escapeHtml(newId)}</code> already exists.`);
      return;
    }
    const parsed = parsePersonaYaml(personaToYaml(source), newId);
    parsed.id = newId;
    parsed.display_name = `${source.display_name.replace(/\s*\(clone\)$/i, '')} (clone)`;
    const saved = await upsertPersona(ctx, parsed, personaToYaml(parsed), 'clone');
    await sendMessage(
      ctx.env,
      chatId,
      `✅ Cloned <code>${escapeHtml(source.id)}</code> → <code>${escapeHtml(saved.id)}</code>. Edit it in the Mini App.`,
    );
    return;
  }

  if (action === 'export') {
    const id = rest[0];
    if (!id) {
      await sendMessage(ctx.env, chatId, 'Usage: <code>/persona export elon</code>');
      return;
    }
    const persona = await getPersona(ctx, id);
    if (!persona) {
      await sendMessage(ctx.env, chatId, `No persona <code>${escapeHtml(id)}</code>.`);
      return;
    }
    await sendDocument(ctx.env, chatId, `${persona.id}.yaml`, personaToYaml(persona), `📄 ${persona.id}.yaml`);
    return;
  }

  if (action === 'import') {
    await sendMessage(
      ctx.env,
      chatId,
      'Send a <code>.yaml</code> file with the caption <code>/persona import</code> (or just send the file).',
    );
    return;
  }

  if (action === 'on' || action === 'off') {
    const id = rest[0];
    if (!id) {
      await sendMessage(ctx.env, chatId, `Usage: <code>/persona ${action} elon</code>`);
      return;
    }
    const persona = await getPersona(ctx, id);
    if (!persona) {
      await sendMessage(ctx.env, chatId, `No persona <code>${escapeHtml(id)}</code>.`);
      return;
    }
    await setPersonaEnabled(ctx, persona.id, action === 'on');
    await sendMessage(ctx.env, chatId, `${action === 'on' ? '🟢' : '⚪️'} <code>${escapeHtml(persona.id)}</code> is now ${action}.`);
    return;
  }

  await sendMessage(
    ctx.env,
    chatId,
    [
      'Persona commands:',
      '<code>/persona add &lt;name&gt;</code> — Scout drafts it, you approve in the Mini App',
      '<code>/persona clone &lt;id&gt; &lt;new_id&gt;</code>',
      '<code>/persona export &lt;id&gt;</code> — sends the YAML file',
      '<code>/persona import</code> — send a YAML file',
      '<code>/persona on|off &lt;id&gt;</code>',
    ].join('\n'),
  );
}

async function handleDocument(ctx: Ctx, msg: TgMessage, chatId: number): Promise<void> {
  const doc = msg.document;
  if (!doc) return;
  const name = doc.file_name ?? 'persona.yaml';
  const caption = (msg.caption ?? '').toLowerCase();
  if (!/\.ya?ml$/i.test(name) && !caption.includes('/persona import')) {
    await sendMessage(ctx.env, chatId, 'Only <code>.yaml</code> personas can be imported.');
    return;
  }

  const raw = await downloadFile(ctx.env, doc.file_id);
  if (!raw) {
    await sendMessage(ctx.env, chatId, '⚠️ Could not download that file.');
    return;
  }

  const persona = parsePersonaYaml(raw, name.replace(/\.ya?ml$/i, ''));
  const existing = await getPersona(ctx, persona.id);
  const saved = await upsertPersona(ctx, persona, raw, 'imported');
  await sendMessage(
    ctx.env,
    chatId,
    `${existing ? '♻️ Updated' : '✅ Imported'} <code>${escapeHtml(saved.id)}</code> — <b>${escapeHtml(saved.display_name)}</b> ${saved.emoji}\n<i>/chat ${escapeHtml(saved.id)} to talk to it.</i>`,
  );
}

// ---------------------------------------------------------------- beliefs

async function beliefsCommand(ctx: Ctx, chatId: number, arg: string): Promise<void> {
  const parts = arg.split(/\s+/).filter(Boolean);
  const personas = await listPersonas(ctx);

  if (!parts.length) {
    await sendMessage(
      ctx.env,
      chatId,
      ['Usage: <code>/beliefs elon [topic]</code>', '', ...personas.map((p) => `${p.emoji} <code>${p.id}</code>`)].join('\n'),
    );
    return;
  }

  const persona = findPersona(personas, parts[0]);
  if (!persona) {
    await sendMessage(ctx.env, chatId, `No persona matches “${escapeHtml(parts[0])}”.`);
    return;
  }
  const topic = parts.slice(1).join(' ').toLowerCase();

  const beliefs = await allBeliefs(ctx, persona.id, { limit: 300 });
  const filtered = topic
    ? beliefs.filter((b) => b.topic_key.includes(topic) || b.topic.toLowerCase().includes(topic))
    : beliefs;

  if (!filtered.length) {
    await sendMessage(
      ctx.env,
      chatId,
      `${persona.emoji} No beliefs stored${topic ? ` for “${escapeHtml(topic)}”` : ''} yet. Run <code>/update ${persona.id}</code>.`,
    );
    return;
  }

  const grouped = new Map<string, typeof filtered>();
  for (const b of filtered) {
    const list = grouped.get(b.topic_key) ?? [];
    list.push(b);
    grouped.set(b.topic_key, list);
  }

  const lines = [`${persona.emoji} <b>${escapeHtml(persona.display_name)}</b> — beliefs`, ''];
  let shown = 0;
  for (const [, list] of grouped) {
    if (shown >= 8) break;
    const current = list.find((b) => !b.superseded_at);
    const history = list.filter((b) => b.superseded_at).slice(0, 3);
    lines.push(`<b>${escapeHtml(list[0].topic)}</b>`);
    if (current) {
      lines.push(`• ${escapeHtml(current.stance)}`);
      lines.push(
        `  <i>since ${current.created_at.slice(0, 10)}${current.is_quote ? ' · quote' : ''} · conf ${current.confidence.toFixed(1)}</i>` +
          (current.source_url ? ` · <a href="${escapeHtml(current.source_url)}">source</a>` : ''),
      );
    } else {
      lines.push('• <i>(superseded)</i>');
    }
    for (const h of history) {
      lines.push(`  ↳ <s>${escapeHtml(h.stance.slice(0, 140))}</s> <i>${h.created_at.slice(0, 10)} → ${h.superseded_at?.slice(0, 10)}</i>`);
    }
    shown++;
  }
  if (grouped.size > shown) lines.push(`\n<i>…and ${grouped.size - shown} more topic(s).</i>`);
  await sendMessage(ctx.env, chatId, lines.join('\n'));
}

// ---------------------------------------------------------------- /status

async function statusCommand(ctx: Ctx, chatId: number): Promise<void> {
  const quota = await getQuota(ctx);
  const model = (await lastSuccessfulModel(ctx)) ?? ctx.models[0] ?? 'n/a';
  const scout = await scoutStatus(ctx);
  const queued = await queuedCount(ctx);
  const enabledPersonas = scout.perPersona.filter((p) => p.enabled).length;
  const debateCalls = (ctx.settings.parallel_round1 ? enabledPersonas : 1) + (ctx.settings.rounds >= 2 ? 1 : 0) + 1;

  const lines = [
    '📊 <b>Council status</b>',
    '',
    `<b>Model in use</b>: <code>${escapeHtml(model)}</code>`,
    `<b>Fallback chain</b>: ${ctx.models.map((m) => `<code>${escapeHtml(m)}</code>`).join(' → ')}`,
    `<b>Free requests left today</b>: ${escapeHtml(formatQuota(quota))}`,
    `<b>Queue</b>: ${queued} job(s) pending`,
    `<b>First-opinion mode</b>: ${ctx.settings.parallel_round1 ? 'separate per persona' : 'batched'} (${debateCalls} calls per Council debate)`,
    '',
    `<b>Personas</b> (${scout.perPersona.filter((p) => p.enabled).length} on)`,
    ...scout.perPersona.map(
      (p) => `${p.emoji} <code>${p.id}</code> · ${p.documents} docs · ${p.beliefs} beliefs · ${p.enabled ? '🟢' : '⚪️'}`,
    ),
    '',
    `<b>Last Scout</b>: ${
      scout.last
        ? `${scout.last.created_at.slice(0, 16).replace('T', ' ')} · ${scout.last.status}${scout.last.error ? ` · ${escapeHtml(scout.last.error.slice(0, 80))}` : ''}`
        : 'never'
    }`,
    `<b>Settings</b>: half-life ${ctx.settings.recency_half_life_days}d · ${ctx.settings.rounds} rounds · ${ctx.settings.persona_word_limit} words · ${ctx.settings.language}`,
  ];

  if (quota.source === 'error' && quota.error) {
    lines.push('', `<i>Quota lookup failed: ${escapeHtml(quota.error.slice(0, 120))}</i>`);
  }
  await sendMessage(ctx.env, chatId, lines.join('\n'));
}

// ---------------------------------------------------------------- helpers

async function getChatMode(ctx: Ctx, chatId: number): Promise<ChatMode> {
  const stored = await getSetting<ChatMode>(ctx, `chatmode:${chatId}`);
  if (stored && (stored.mode === 'council' || stored.mode === 'chat')) return stored;
  return { mode: 'council' };
}

export function findPersona(personas: PersonaRow[], needle: string): PersonaRow | null {
  const n = needle.trim().toLowerCase();
  if (!n) return null;
  return (
    personas.find((p) => p.id === n) ??
    personas.find((p) => p.display_name.toLowerCase() === n) ??
    personas.find((p) => p.display_name.toLowerCase().startsWith(n)) ??
    personas.find((p) => p.id.startsWith(n)) ??
    personas.find((p) => p.display_name.toLowerCase().includes(n)) ??
    null
  );
}

function helpText(): string {
  return [
    '🧠 <b>Council</b> — five agents in one chat.',
    '',
    '🔍 <b>Scout</b> refreshes Elon, Sam and Dario before you speak.',
    '🗣 <b>Three personas</b> answer, read each other, and reply.',
    '📝 <b>Scribe</b> closes with the verdict, next steps and a NotebookLM pack.',
    '',
    '<b>Talk</b>',
    'Just send a message — follow-ups stay in the same thread.',
    '/new — start a fresh thread',
    '/end — Scribe writes the final summary + .md',
    '/more — one more round',
    '/me &lt;text&gt; — join in',
    '/dig #tag — Scout + quick debate',
    '',
    '<b>People</b>',
    '/personas — list',
    '/chat elon — 1:1 chat',
    '/council — back to the group',
    '/persona add|clone|export|import|on|off',
    '/beliefs elon [topic] — stances + history',
    '',
    '<b>System</b>',
    '/update [persona] — run Scout now',
    '/notebook [id] — rebuild the pack',
    '/status — model, free quota, sources',
    '',
    '<i>Every persona message is a simulation. Claims cite stored sources; anything else is labelled inference.</i>',
  ].join('\n');
}

function settingsHint(ctx: Ctx): string {
  const debateCalls = (ctx.settings.parallel_round1 ? 3 : 1) + (ctx.settings.rounds >= 2 ? 1 : 0) + 1;
  return [
    '⚙️ <b>Settings</b> live in the Mini App (menu button).',
    '',
    `recency half-life: <b>${ctx.settings.recency_half_life_days}</b> days`,
    `rounds: <b>${ctx.settings.rounds}</b>`,
    `words per persona: <b>${ctx.settings.persona_word_limit}</b>`,
    `language: <b>${ctx.settings.language}</b>`,
    `separate first opinions: <b>${ctx.settings.parallel_round1 ? 'on' : 'off'}</b> · about ${debateCalls} calls/debate`,
    '',
    `<code>${escapeHtml(ctx.models[0] ?? 'no model configured')}</code>`,
  ].join('\n');
}
