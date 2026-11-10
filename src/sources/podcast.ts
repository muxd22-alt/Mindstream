import type { FetchedDoc, FeedSpec } from '../types';
import { fetchText } from './fetch';
import { parseFeed } from './xml';
import { buildContent } from './common';
import { truncate } from '../util/text';

/** Podcast RSS: we keep the show notes (full text when present) + the audio URL. */
export async function fetchPodcast(
  feed: FeedSpec,
  max = 6,
): Promise<{ docs: FetchedDoc[]; error?: string; note?: string }> {
  if (!feed.url) return { docs: [], error: 'missing url' };
  const res = await fetchText(feed.url);
  if (!res.ok) return { docs: [], error: `podcast → ${res.error}` };
  const parsed = parseFeed(res.text);

  const docs: FetchedDoc[] = [];
  for (const item of parsed.items) {
    const content = buildContent(item);
    if (content.length < 80) continue;
    docs.push({
      url: item.link,
      title: truncate(item.title, 300),
      content: truncate(content, 16_000, ''),
      publishedAt: item.published,
      kind: 'podcast',
      meta: { show: parsed.title, audio: item.audioUrl ?? null },
      feedLabel: feed.label,
    });
    if (docs.length >= max) break;
  }
  return { docs, note: `${docs.length} episode(s) from ${parsed.title}` };
}
