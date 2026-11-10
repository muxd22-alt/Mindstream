import type { FetchedDoc, FeedSpec } from '../types';
import { fetchText } from './fetch';
import { parseFeed } from './xml';
import { itemsToDocs } from './common';

export interface FeedResult {
  docs: FetchedDoc[];
  error?: string;
  note?: string;
}

export async function fetchRss(feed: FeedSpec, opts: { kind?: 'rss' | 'podcast'; max?: number } = {}): Promise<FeedResult> {
  const url = feed.url;
  if (!url) return { docs: [], error: 'missing url' };
  const res = await fetchText(url);
  if (!res.ok) return { docs: [], error: `${url} → ${res.error}` };
  const parsed = parseFeed(res.text);
  if (!parsed.items.length) return { docs: [], error: `${url} → no items (not a feed?)` };
  return {
    docs: itemsToDocs(parsed.items, {
      kind: opts.kind ?? 'rss',
      max: opts.max ?? 10,
      feedLabel: feed.label,
      meta: { feed: parsed.title },
    }),
    note: `${parsed.items.length} item(s)`,
  };
}
