import type { FetchedDoc, FeedKind } from '../types';
import type { FeedItem } from './xml';
import { htmlToText, normalizeWs, truncate } from '../util/text';

export function itemsToDocs(
  items: FeedItem[],
  opts: { kind: FeedKind; filterHost?: string | null; max?: number; feedLabel?: string; meta?: Record<string, unknown> },
): FetchedDoc[] {
  const out: FetchedDoc[] = [];
  const limit = opts.max ?? 10;
  for (const item of items) {
    if (!item.link) continue;
    const content = buildContent(item);
    if (content.length < 40) continue;
    out.push({
      url: item.link,
      title: truncate(item.title, 300),
      content,
      publishedAt: item.published,
      kind: opts.kind,
      meta: { ...(opts.meta ?? {}), guid: item.guid, audio: item.audioUrl ?? null },
      feedLabel: opts.feedLabel,
    });
    if (out.length >= limit) break;
  }
  return out;
}

export function buildContent(item: FeedItem): string {
  const fromHtml = normalizeWs(htmlToText(item.contentHtml));
  const summary = normalizeWs(item.summary);
  const best = fromHtml.length > summary.length ? fromHtml : summary;
  const body = best || '';
  if (body.includes(item.title.slice(0, 40))) return body;
  return normalizeWs(`${item.title}\n\n${body}`);
}

export function isGoogleNews(url: string): boolean {
  return /news\.google\.com/.test(url);
}

export function googleNewsUrl(query: string): string {
  const arabic = /[\u0600-\u06FF]/.test(query);
  const params = arabic
    ? `hl=ar&gl=SA&ceid=SA:ar`
    : `hl=en-US&gl=US&ceid=US:en`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&${params}`;
}

export function cleanTitle(title: string): string {
  return normalizeWs(title.replace(/\s+-\s+[^-]{2,40}$/, (m) => m)).slice(0, 300);
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
