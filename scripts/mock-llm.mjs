#!/usr/bin/env node
// Local-only mock of OpenRouter + Workers AI, for end-to-end testing without
// spending quota or holding a key. Not used in production.
//
//   node scripts/mock-llm.mjs 8899
//
// Then in .dev.vars:
//   OPENROUTER_BASE_URL=http://127.0.0.1:8899/api/v1
//   CF_AI_BASE_URL=http://127.0.0.1:8899/ai/run
import http from 'node:http';

const port = Number(process.argv[2] || 8899);
const log = [];
let failFirst = false;
let beliefVersion = 0;

const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');

  if (req.url === '/__control/fail-first') {
    failFirst = !failFirst;
    return json(res, { failFirst });
  }

  if (req.url?.endsWith('/chat/completions')) {
    const body = JSON.parse(raw || '{}');
    const messages = body.messages ?? [];
    const system = messages[0]?.content ?? '';
    const user = messages[messages.length - 1]?.content ?? '';

    if (failFirst && /nemotron-3-ultra/.test(body.model)) {
      console.log(`[llm] 429 ${body.model}`);
      return json(res, { error: { code: 429, message: 'mock rate limit' } }, 429);
    }

    const content = answer(system, user);
    log.push({ model: body.model, kind: kindOf(system), chars: content.length });
    console.log(`[llm] ${body.model} ${kindOf(system)} (${content.length} chars)`);
    return json(res, { choices: [{ message: { content }, finish_reason: 'stop' }] });
  }

  if (req.url?.endsWith('/key')) {
    return json(res, {
      data: { label: 'mock', is_free_tier: true, free_model_daily_requests: 42, limit: null, usage: 8 },
    });
  }

  if (req.url?.includes('/ai/run/')) {
    const body = JSON.parse(raw || '{}');
    const texts = Array.isArray(body.text) ? body.text : [body.text];
    return json(res, { result: { data: texts.map(embed) }, success: true, errors: [] });
  }

  json(res, { error: 'not found' }, 404);
});

function answer(system, user) {
  if (/round 1/i.test(system) && /one persona/i.test(system)) {
    return JSON.stringify(singleRound1(user));
  }
  if (/round 2/i.test(system)) return JSON.stringify({ replies: round2(user) });
  if (/round 1/i.test(system)) return JSON.stringify({ rounds: round1(user) });
  if (/scribe/i.test(system)) return JSON.stringify(scribe(user));
  if (/belief/i.test(system)) return JSON.stringify(beliefs(user));
  if (/1:1 chat/i.test(system)) return 'This is a simulated reply for testing.';
  return '{}';
}

function kindOf(system) {
  if (/round 1/i.test(system) && /one persona/i.test(system)) return 'round1-single';
  if (/round 2/i.test(system)) return 'round2';
  if (/round 1/i.test(system)) return 'round1';
  if (/scribe/i.test(system)) return 'scribe';
  if (/belief/i.test(system)) return 'beliefs';
  return 'other';
}

function namesFrom(text) {
  return [...text.matchAll(/^### ([a-z0-9_]+) —/gm)].map((m) => m[1]);
}

function round1(user) {
  const ids = namesFrom(user);
  return ids.map((id, i) => ({
    persona_id: id,
    answer: ['yes', 'no', 'depends'][i % 3],
    reasoning: `Test answer for ${id}. It cites a stored source. `.repeat(6).trim(),
    citations: user.includes('[S1]') ? ['S1'] : [],
    inference: false,
  }));
}

/** Single-persona prompt: one object, not an array. */
function singleRound1(user) {
  const id = user.match(/^### ([a-z0-9_]+) —/m)?.[1] ?? 'persona';
  return {
    persona_id: id,
    answer: ['yes', 'no', 'depends'][id.length % 3],
    reasoning: `${id} answers live, in character, citing what is stored. `.repeat(5).trim(),
    citations: user.includes('[S1]') ? ['S1'] : [],
    inference: false,
  };
}

function round2(user) {
  const ids = namesFrom(user);
  return ids.map((id, i) => ({
    persona_id: id,
    reply: `${id} responds to the others with a short, in-character rebuttal.`,
    reaction: i === 0 ? 'push_back' : i === 1 ? 'change_mind' : 'agree',
    answer: ['no', 'depends', 'yes'][i % 3],
  }));
}

function scribe() {
  return {
    headline: 'A conditional yes, but the timing is contested.',
    verdicts: [],
    agreements: ['All three tie the decision to long-run cost, not monthly payment.'],
    disagreements: ['Elon focuses on asset mobility; Sam on rates; Dario on downside risk.'],
    next_steps: ['Get a SAMA-authorised pre-approval.', 'Compare Sakani eligibility.', 'Model a 10-year exit.'],
    hashtags: ['#saudi_mortgage', '#sama_rules', '#sakani', '#down_payment', '#vision_2030'],
    search_keywords: { ar: ['التمويل العقاري', 'ساما'], en: ['mortgage', 'sama rules'] },
    disclaimer: 'Simulated debate — not financial advice.',
  };
}

function beliefs(user) {
  beliefVersion++;
  const stances = [
    'Conditionally in favour when financing costs are locked and the horizon is long.',
    'Strongly against buying with debt right now because rates and job risk dominate the upside.',
  ];
  return {
    beliefs: [
      {
        source_index: 0,
        topic: 'saudi mortgage market',
        stance: stances[(beliefVersion - 1) % 2],
        quote_or_paraphrase: 'A paraphrased position for testing.',
        is_quote: false,
        confidence: 0.72,
        date: '2026-10-01',
      },
    ],
  };
}

/** Bag-of-words hashing so similar text lands in similar places. */
function embed(text) {
  const v = new Array(1024).fill(0);
  const words = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (const w of words) {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
    v[h % 1024] += 1;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

server.listen(port, '127.0.0.1', () => console.log(`mock llm on http://127.0.0.1:${port}`));
