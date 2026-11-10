import type { FetchedDoc, FeedSpec } from '../types';
import { fetchText } from './fetch';
import { parseFeed } from './xml';
import { googleNewsUrl, itemsToDocs } from './common';

/**
 * Google News RSS search. The item links are news.google.com redirects; they
 * still open the article in a browser, and the redirect URL is stable, which is
 * what dedupe needs.
 */
export async function fetchGoogleNews(feed: FeedSpec, max = 12): Promise<{ docs: FetchedDoc[]; error?: string; note?: string }> {
  const query = feed.query;
  if (!query) return { docs: [], error: 'missing query' };
  const url = googleNewsUrl(query);
  const res = await fetchText(url);
  if (!res.ok) return { docs: [], error: `google news → ${res.error}` };
  const parsed = parseFeed(res.text);
  if (!parsed.items.length) return { docs: [], error: 'google news → no items' };
  const docs = itemsToDocs(parsed.items, {
    kind: 'googlenews',
    max,
    feedLabel: feed.label ?? 'google-news',
    meta: { query, provider: 'google-news' },
  });
  return { docs, note: `${docs.length} headline(s)` };
}
