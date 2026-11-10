import type { FetchedDoc, FeedSpec } from '../types';
import { fetchText } from './fetch';
import { parseFeed, extractLinks, extractArticle, parseDate } from './xml';
import { itemsToDocs } from './common';
import { normalizeUrl } from '../util/hash';
import { truncate } from '../util/text';

const CANDIDATE_FEEDS = [
  '',
  '/feed',
  '/rss',
  '/rss.xml',
  '/feed.xml',
  '/atom.xml',
  '/index.xml',
  '/posts.xml',
];

/**
 * Official blogs are inconsistent: some have RSS, some are JS-rendered.
 * Strategy: probe common feed paths, fall back to scraping the index and
 * fetching the first few articles.
 */
export async function fetchBlog(feed: FeedSpec, opts: { maxArticles?: number } = {}): Promise<{ docs: FetchedDoc[]; error?: string; note?: string }> {
  const base = feed.url;
  if (!base) return { docs: [], error: 'missing url' };
  let origin = base;
  try {
    origin = new URL(base).origin;
  } catch {
    return { docs: [], error: `bad url: ${base}` };
  }

  const notes: string[] = [];

  // 1) Feed probe
  for (const path of CANDIDATE_FEEDS) {
    const candidate = path === '' ? base : `${origin}${path}`;
    const res = await fetchText(candidate, { timeoutMs: 15_000 });
    if (!res.ok || !res.text.trimStart().startsWith('<')) continue;
    const head = res.text.slice(0, 600).toLowerCase();
    if (!head.includes('<rss') && !head.includes('<feed') && !head.includes('<rdf')) continue;
    const parsed = parseFeed(res.text);
    if (parsed.items.length >= 1) {
      const docs = itemsToDocs(parsed.items, {
        kind: 'blog',
        max: 8,
        feedLabel: feed.label,
        meta: { feed: parsed.title, discoveredFeed: candidate },
      });
      if (docs.length) {
        notes.push(`feed ${candidate} (${parsed.items.length} items)`);
        return { docs, note: notes.join('; ') };
      }
    }
  }

  // 2) HTML index fallback
  const index = await fetchText(base, { timeoutMs: 20_000 });
  if (!index.ok) return { docs: [], error: `${base} → ${index.error}` };
  const links = extractLinks(index.text, base).filter((l) => !normalizeUrl(l.url).endsWith('/'));
  if (!links.length) return { docs: [], error: 'no feed and no article links found' };

  const seen = new Set<string>();
  const candidates = links
    .filter((l) => {
      const u = normalizeUrl(l.url);
      if (seen.has(u)) return false;
      seen.add(u);
      return l.url.split('/').filter(Boolean).length >= 2;
    })
    .slice(0, Math.min(opts.maxArticles ?? 3, 3));

  const docs: FetchedDoc[] = [];
  for (const link of candidates.slice(0, Math.min(opts.maxArticles ?? 2, 3))) {
    const page = await fetchText(link.url, { timeoutMs: 18_000 });
    if (!page.ok || page.text.length < 500) continue;
    const article = extractArticle(page.text);
    if (article.text.length < 300) continue;
    docs.push({
      url: link.url,
      title: truncate(article.title, 300),
      content: truncate(article.text, 14_000, ''),
      publishedAt: article.published ?? parseDate(null),
      kind: 'blog',
      meta: { scraped: true, index: base },
      feedLabel: feed.label,
    });
  }
  return {
    docs,
    error: docs.length ? undefined : 'blog index scraped but no article text extracted',
    note: `html fallback, ${docs.length} article(s)`,
  };
}
