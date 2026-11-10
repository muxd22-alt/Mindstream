import type { FetchedDoc, FeedSpec } from '../types';
import { fetchText } from './fetch';
import { parseFeed } from './xml';
import { buildContent } from './common';
import { truncate } from '../util/text';

/**
 * YouTube channel RSS. `channel_id` is used when known; otherwise the @handle
 * is resolved from the channel page. Transcripts are added later by the
 * `yt-transcripts` GitHub Action (youtube-transcript-api), because that library
 * needs Node and may be blocked from datacentres — we skip and log if so.
 */
export async function fetchYouTube(
  feed: FeedSpec,
  max = 8,
): Promise<{ docs: FetchedDoc[]; error?: string; note?: string }> {
  let channelId = feed.channel_id ?? null;

  if (!channelId && feed.handle) {
    const handle = feed.handle.startsWith('@') ? feed.handle : `@${feed.handle}`;
    const page = await fetchText(`https://www.youtube.com/${handle}`, { timeoutMs: 20_000 });
    if (page.ok) {
      channelId =
        page.text.match(/"externalId":"(UC[0-9A-Za-z_-]{22})"/)?.[1] ??
        page.text.match(/"channelId":"(UC[0-9A-Za-z_-]{22})"/)?.[1] ??
        page.text.match(/youtube\.com\/channel\/(UC[0-9A-Za-z_-]{22})/)?.[1] ??
        null;
    }
  }

  if (!channelId && feed.url) {
    const m = feed.url.match(/channel_id=(UC[0-9A-Za-z_-]{22})/);
    channelId = m?.[1] ?? null;
  }

  if (!channelId) {
    return { docs: [], error: `could not resolve channel for ${feed.handle ?? feed.url ?? 'youtube'}` };
  }

  const res = await fetchText(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
  if (!res.ok) return { docs: [], error: `youtube feed → ${res.error}` };

  const parsed = parseFeed(res.text);
  const docs: FetchedDoc[] = [];
  for (const item of parsed.items) {
    const content = buildContent(item);
    if (content.length < 40) continue;
    const videoId = item.guid?.match(/yt:video:(.+)$/)?.[1] ?? item.link.match(/[?&]v=([\w-]{6,})/)?.[1] ?? null;
    docs.push({
      url: item.link,
      title: truncate(item.title, 300),
      content,
      publishedAt: item.published,
      kind: 'youtube',
      meta: { channelId, videoId, transcript: false },
      feedLabel: feed.label,
    });
    if (docs.length >= max) break;
  }

  return { docs, note: `channel ${channelId}, ${docs.length} video(s)` };
}
