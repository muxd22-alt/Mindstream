// Self-test for the pure logic that is easy to get wrong.
// Run: npm run selftest
import assert from 'node:assert/strict';
import { parsePersonaYaml, personaToYaml } from '../src/personas/loader';
import { SEED_PERSONAS } from '../src/generated/personas';
import { chunkText } from '../src/ai/chunk';
import { encodeVector, decodeVector, cosine, recencyWeight } from '../src/ai/embed';
import { extractJson, oneOf, asArray } from '../src/llm/json';
import { renderPrompt, splitSystemUser } from '../src/prompts';
import { resolveCitations } from '../src/agents/debate';
import { parseRound1, parseRound2, parseScribe } from '../src/agents/debate';
import { renderPersonaAnswer, renderScribe } from '../src/telegram/format';
import type { Citation, DebateRow, PersonaRow, Round1Item } from '../src/types';
import {
  cleanHashtag,
  detectLang,
  limitWords,
  normalizeWs,
  stanceChanged,
  topicKey,
  uniqueBy,
  jaccard,
} from '../src/util/text';
import { normalizeUrl } from '../src/util/hash';
import { defaultFooter, isSensitiveQuestion, isSaudiRelevant, safetyLine } from '../src/util/safety';
import { splitForTelegram } from '../src/telegram/api';
import { digQuery } from '../src/agents/dig';
import { parseInitData } from '../src/api/auth';
import type { Citation } from '../src/types';

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  })();
}

async function main() {
  console.log('Council self-test\n');

  await test('all seed personas parse and keep their feeds', () => {
    const ids = Object.values(SEED_PERSONAS).map((yaml) => parsePersonaYaml(yaml));
    assert.equal(ids.length, 3);
    for (const p of ids) {
      assert.ok(p.id, 'id');
      assert.ok(p.display_name, 'display_name');
      assert.ok(p.source_feeds.length >= 2, `${p.id} feeds`);
      assert.ok(p.bio.length > 20, `${p.id} bio`);
    }
  });

  await test('persona YAML round-trips', () => {
    const p = parsePersonaYaml(Object.values(SEED_PERSONAS)[0]);
    const back = parsePersonaYaml(personaToYaml(p));
    assert.equal(back.id, p.id);
    assert.deepEqual(back.source_feeds.map((f) => f.type), p.source_feeds.map((f) => f.type));
  });

  await test('bad persona YAML is rejected with a readable error', () => {
    assert.throws(() => parsePersonaYaml('- just\n- a list\n'));
    assert.throws(() => parsePersonaYaml('id: Bad Id!\ndisplay_name: ""\n'));
  });

  await test('chunking respects the cap and keeps Arabic intact', () => {
    const para = 'هذا نص عربي طويل عن التمويل العقاري في السعودية وبرنامج سكني. '.repeat(40);
    const chunks = chunkText(para, { maxChars: 1200, overlapChars: 0 });
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.content.length <= 1250, `chunk ${c.content.length}`);
    assert.ok(chunks.every((c) => c.content.includes('التمويل')));
  });

  await test('JSON extraction survives fences, prose and trailing commas', () => {
    assert.deepEqual(extractJson('```json\n{"a":1,}\n```'), { a: 1 });
    assert.deepEqual(extractJson('Sure! Here you go: {"a":[1,2]} hope this helps'), { a: [1, 2] });
    assert.deepEqual(extractJson('[{"x":"}"}]'), [{ x: '}' }]);
    assert.equal(extractJson('not json at all'), null);
    assert.deepEqual(asArray({ rounds: [{ a: 1 }] }), [{ a: 1 }]);
    assert.equal(oneOf('YES', ['yes', 'no'] as const, 'no'), 'yes');
  });

  await test('citations are only kept when they match a retrieved source', () => {
    const refs = new Map<string, Citation>([
      ['S1', { title: 'A', date: '2025-01-01', url: 'https://a.example', ref: 'S1' }],
      ['S2', { title: 'B', date: null, url: 'https://b.example', ref: 'S2' }],
    ]);
    const kept = resolveCitations(['S1', 'S9', { url: 'https://b.example' }, { url: 'https://invented.example' }], refs);
    assert.deepEqual(kept.map((c) => c.url), ['https://a.example', 'https://b.example']);
    assert.equal(resolveCitations(['S3'], refs).length, 0);
  });

  await test('hashtags are sanitised and deduped', () => {
    assert.equal(cleanHashtag('#Saudi Mortgage Rates!'), '#saudi_mortgage_rates');
    assert.equal(cleanHashtag('##'), null);
    const tags = uniqueBy(['#a_b', '#a_b', '#c'], (t) => t);
    assert.equal(tags.length, 2);
  });

  await test('language detection handles Arabic and English', () => {
    assert.equal(detectLang('هل اشتري بيت بالتمويل العقاري؟'), 'ar');
    assert.equal(detectLang('Should I buy a house with a mortgage?'), 'en');
    assert.equal(detectLang('mixed AR/EN text'), 'en');
  });

  await test('word cap never exceeds the configured limit', () => {
    const text = 'word '.repeat(400);
    assert.ok(limitWords(text, 120).split(/\s+/).length <= 121);
    assert.equal(limitWords('short answer', 120), 'short answer');
  });

  await test('topic keys and stance change detection behave', () => {
    assert.equal(topicKey('The Saudi Mortgage Market'), 'saudi mortgage market');
    assert.ok(jaccard('open source AI is good', 'open source AI is good') === 1);
    assert.equal(stanceChanged('I support open weights', 'I support open weights'), false);
    assert.equal(
      stanceChanged('I strongly support open-weight releases for everyone', 'I oppose open-weight frontier releases'),
      true,
    );
  });

  await test('prompts render with no leftover placeholders', () => {
    for (const name of ['round1', 'round2', 'scribe', 'beliefs', 'chat', 'persona_draft']) {
      const rendered = renderPrompt(name, {
        question: 'Q',
        language: 'English',
        word_limit: 120,
        today: '2026-01-01',
        safety_line: '',
        persona_blocks: 'P',
        round1_block: 'R',
        transcript: 'T',
        sources_block: 'S',
        persona_name: 'N',
        persona_id: 'n',
        persona_block: 'P',
        beliefs_block: 'B',
        history_block: 'H',
        message: 'M',
        documents: 'D',
        name: 'N',
        hint_line: '',
        sweep: 'W',
      });
      assert.ok(!/\{\{/.test(rendered), `${name} has placeholders: ${rendered.match(/\{\{[^}]+\}\}/)?.[0]}`);
    }
    const split = splitSystemUser('SYS\n---\nUSER');
    assert.equal(split.system, 'SYS');
    assert.equal(split.user, 'USER');
  });

  await test('vector codec round-trips and cosine is sane', () => {
    const v = Array.from({ length: 1024 }, (_, i) => Math.sin(i / 7));
    const decoded = decodeVector(encodeVector(v));
    assert.equal(decoded.length, 1024);
    const back = Array.from(decoded);
    assert.ok(Math.abs(back[10] - v[10]) < 1e-6);
    assert.ok(Math.abs(cosine(decodeVector(encodeVector(v)), decodeVector(encodeVector(v))) - 1) < 1e-6);
    assert.ok(recencyWeight(new Date().toISOString(), 90) > 0.99);
    assert.ok(recencyWeight(new Date(Date.now() - 90 * 86400_000).toISOString(), 90) - 0.5 < 0.01);
  });

  await test('URL normalisation dedupes tracking noise', () => {
    const a = normalizeUrl('https://Example.com/post/?utm_source=x&ref=y#frag');
    const b = normalizeUrl('https://example.com/post');
    assert.equal(a, b);
  });

  await test('safety footers fire for money/health/legal and Saudi context', () => {
    assert.ok(isSensitiveQuestion('Should I buy a house with a mortgage in Saudi Arabia?'));
    assert.ok(isSensitiveQuestion('هل اشتري بيت بالتمويل العقاري؟'));
    assert.ok(!isSensitiveQuestion('What is the meaning of life?'));
    assert.ok(isSaudiRelevant('هل اشتري بيت بالتمويل العقاري؟'));
    assert.ok(isSensitiveQuestion('هل هذا الدواء آمن؟'));
    assert.match(defaultFooter('ar'), /محاكاة/);
    assert.match(safetyLine('mortgage in Riyadh', 'en'), /SAMA/);
  });

  await test('long Telegram messages split under the limit', () => {
    const parts = splitForTelegram('para\n\n'.repeat(900), 4000);
    assert.ok(parts.length > 1);
    for (const p of parts) assert.ok(p.length <= 4000);
  });

  await test('dig query normalisation', () => {
    assert.equal(digQuery('#saudi_mortgage_sama', 'en'), 'saudi mortgage sama');
    assert.equal(digQuery('  mortgage   rates ', 'en'), 'mortgage rates');
  });

  await test('Telegram initData HMAC validation', async () => {
    const botToken = '123456:TEST-TOKEN';
    const enc = new TextEncoder();
    const user = { id: 42, first_name: 'Owner' };
    const authDate = Math.floor(Date.now() / 1000);
    const params: [string, string][] = [
      ['auth_date', String(authDate)],
      ['query_id', 'AAF'],
      ['user', JSON.stringify(user)],
    ];
    const dcs = [...params].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');

    const k1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const secret = await crypto.subtle.sign('HMAC', k1, enc.encode(botToken));
    const k2 = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = await crypto.subtle.sign('HMAC', k2, enc.encode(dcs));
    const hash = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');

    const initData = new URLSearchParams([...params, ['hash', hash]]).toString();
    const good = await parseInitData(initData, botToken);
    assert.equal(good.ok, true);
    assert.equal(good.user?.id, 42);

    const tampered = initData.replace(/user=[^&]+/, 'user=%7B%22id%22%3A99%7D');
    assert.equal((await parseInitData(tampered, botToken)).ok, false);
  });

  await test('whitespace normalisation', () => {
    assert.equal(normalizeWs('a\r\n\r\n\r\nb   c'), 'a\n\nb c');
  });

  // ---------------------------------------------------------------- debate engine

  const personas: PersonaRow[] = [
    {
      id: 'elon',
      display_name: 'Elon',
      emoji: '🚀',
      bio: 'b',
      speaking_style: 's',
      core_values: [],
      known_biases: [],
      topics_of_expertise: [],
      source_feeds: [],
      model_override: null,
      enabled: true,
      yaml: '',
      origin: 'seed',
    },
    {
      id: 'sam',
      display_name: 'Sam',
      emoji: '🧭',
      bio: 'b',
      speaking_style: 's',
      core_values: [],
      known_biases: [],
      topics_of_expertise: [],
      source_feeds: [],
      model_override: null,
      enabled: true,
      yaml: '',
      origin: 'seed',
    },
  ];
  const refs = {
    elon: { S1: { title: 'A', date: '2026-01-01', url: 'https://a.example', ref: 'S1' } },
    sam: {},
  };

  await test('round 1 parsing keeps only real citations and marks inference', () => {
    const items = parseRound1(
      JSON.stringify({
        rounds: [
          { persona_id: 'elon', answer: 'no', reasoning: 'Because of A.', citations: ['S1'] },
          { persona_id: 'sam', answer: 'yes', reasoning: 'Because of vibes.', citations: ['S1'] },
        ],
      }),
      personas,
      refs,
      120,
      'en',
    );
    assert.equal(items[0].citations.length, 1);
    assert.equal(items[0].inference, false);
    assert.equal(items[1].citations.length, 0);
    assert.equal(items[1].inference, true, 'uncited claim must be inference');
  });

  await test('round 1 tolerates missing personas and prose', () => {
    const items = parseRound1('Sure!\n```json\n{"rounds":[{"persona_id":"sam","answer":"DEPENDS","reasoning":"x"}]}\n```', personas, refs, 120, 'en');
    assert.equal(items.length, 2);
    assert.equal(items[0].answer, 'depends');
    assert.equal(items[0].inference, true);
  });

  await test('round 1 accepts the single-persona shape used by live mode', () => {
    const items = parseRound1(
      '{"persona_id":"elon","answer":"no","reasoning":"Live answer.","citations":["S1"]}',
      [personas[0]],
      { elon: refs.elon },
      120,
      'en',
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].personaId, 'elon');
    assert.equal(items[0].answer, 'no');
    assert.equal(items[0].citations.length, 1);
    assert.equal(items[0].inference, false);
  });

  await test('round 2 parsing keeps prior answers when omitted', () => {
    const round1: Round1Item[] = [
      { personaId: 'elon', answer: 'no', reasoning: 'r', citations: [], inference: true },
      { personaId: 'sam', answer: 'yes', reasoning: 'r', citations: [], inference: true },
    ];
    const items = parseRound2(
      JSON.stringify({ replies: [{ persona_id: 'elon', reply: 'I still disagree.', reaction: 'push_back' }] }),
      personas,
      round1,
      120,
    );
    assert.equal(items.length, 2);
    assert.equal(items[0].answer, 'no');
    assert.equal(items[1].answer, 'yes');
  });

  await test('scribe output is normalised to 5 hashtags, 3 steps and a disclaimer', () => {
    const debate = {
      id: 'dbt_test',
      question: 'Should I buy a house with a mortgage in Saudi Arabia?',
      lang: 'en',
      state: { round1: [] },
    } as unknown as DebateRow;
    const scribe = parseScribe(
      JSON.stringify({
        headline: 'H',
        verdicts: [{ persona_id: 'elon', answer: 'no', top_reason: 'rates' }],
        agreements: ['a'],
        disagreements: ['d'],
        next_steps: ['one'],
        hashtags: ['#Saudi Mortgage', '#sama', '#x'],
        search_keywords: { ar: ['رهن'], en: ['mortgage'] },
        disclaimer: null,
      }),
      debate,
      personas,
      'en',
    );
    assert.equal(scribe.hashtags.length, 5);
    assert.ok(scribe.hashtags.every((h) => h.startsWith('#') && !h.includes(' ')));
    assert.equal(scribe.next_steps.length, 3);
    assert.equal(scribe.verdicts.length, 2);
    assert.match(scribe.disclaimer ?? '', /not financial, medical or legal advice/);
  });

  await test('Telegram rendering is escaped, labelled simulated and cites links', () => {
    const persona = personas[0];
    const html = renderPersonaAnswer(
      persona,
      {
        personaId: 'elon',
        answer: 'no',
        reasoning: 'A <script> & "quotes"',
        citations: [{ title: 'Src & A', date: '2026-01-01', url: 'https://a.example?x=1&y=2' }],
        inference: false,
      },
      'en',
    );
    assert.ok(html.includes('simulated'), 'must be labelled simulated');
    assert.ok(html.includes('&lt;script&gt;'), 'html escaped');
    assert.ok(html.includes('✅') || html.includes('❌'));
    assert.ok(html.includes('https://a.example?x=1&amp;y=2'));

    const scribe = parseScribe(
      JSON.stringify({
        headline: 'H',
        verdicts: [{ persona_id: 'elon', answer: 'no', top_reason: 'rates' }],
        agreements: [],
        disagreements: [],
        next_steps: ['a', 'b', 'c'],
        hashtags: ['#a', '#b', '#c', '#d', '#e'],
        search_keywords: { ar: [], en: [] },
        disclaimer: 'Not financial advice.',
      }),
      { id: 'x', question: 'money?', lang: 'en', state: {} } as unknown as DebateRow,
      personas,
      'en',
    );
    const scribeHtml = renderScribe(scribe, {
      lang: 'en',
      personas,
      question: 'money?',
      debateId: 'dbt_x',
    });
    assert.ok(scribeHtml.includes('Verdict') || scribeHtml.includes('verdict'));
    assert.ok(scribeHtml.includes('#a'));
    assert.ok(scribeHtml.includes('/notebook dbt_x'));
  });

  console.log(`\n${passed} tests passed.`);
}

main().catch((e) => {
  console.error('\n✗ FAILED:', e);
  process.exit(1);
});
