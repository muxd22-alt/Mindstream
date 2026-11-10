#!/usr/bin/env node
// Fetches YouTube transcripts for recent videos already stored by Scout, then
// sends them to the Worker, which replaces the short description with the full
// transcript and re-chunks. Skips quietly when YouTube blocks datacentre IPs.

const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const token = process.env.INTERNAL_TOKEN || '';
const onlyPersona = (process.env.PERSONA || '').trim();
const maxPerPersona = Number(process.env.MAX || 4) || 4;

if (!base || !token) {
  console.error('PUBLIC_BASE_URL and INTERNAL_TOKEN are required');
  process.exit(0);
}

let YoutubeTranscript;
try {
  ({ YoutubeTranscript } = await import('youtube-transcript'));
} catch {
  console.log('youtube-transcript not installed — skipping transcript run.');
  process.exit(0);
}

async function internal(path, body, method = 'POST') {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-internal-token': token },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

const snap = await internal('/internal/snapshot', null, 'GET');

let total = 0;
for (const block of snap.documents ?? []) {
  const personaId = block.persona_id;
  if (onlyPersona && personaId !== onlyPersona) continue;

  const videos = (block.documents ?? [])
    .filter((d) => d.kind === 'youtube' && typeof d.url === 'string')
    .map((d) => ({ ...d, videoId: videoIdOf(d.url) }))
    .filter((d) => d.videoId)
    .slice(0, maxPerPersona);

  if (!videos.length) continue;

  const docs = [];
  for (const v of videos) {
    try {
      const segments = await YoutubeTranscript.fetchTranscript(v.videoId, { lang: 'en' });
      const text = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
      if (text.length < 500) continue;
      docs.push({
        url: v.url,
        title: v.title || 'YouTube video',
        publishedAt: v.published_at ?? null,
        content: text,
        kind: 'youtube',
        meta: { videoId: v.videoId, transcript: true },
      });
      console.log(`✓ ${personaId} · ${v.videoId} · ${text.length} chars`);
    } catch (e) {
      console.log(`· skipped ${personaId} ${v.videoId}: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
    }
  }

  if (docs.length) {
    const result = await internal('/internal/ingest', { persona_id: personaId, docs });
    console.log(`${personaId}:`, JSON.stringify(result.result));
    total += docs.length;
  }
}

console.log(`done — ${total} transcript(s)`);
process.exit(0);

function videoIdOf(url) {
  const m = String(url).match(/[?&]v=([\w-]{6,})/) || String(url).match(/youtu\.be\/([\w-]{6,})/);
  return m?.[1] ?? null;
}
