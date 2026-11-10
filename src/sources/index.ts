import type { Ctx, FetchedDoc, FeedSpec, Persona } from '../types';
import { fetchRss } from './rss';
import { fetchGoogleNews } from './googlenews';
import { fetchBlog } from './blog';
import { fetchYouTube } from './youtube';
import { fetchPodcast } from './podcast';

export interface FeedOutcome {
  docs: FetchedDoc[];
  error?: string;
  note?: string;
}

export interface SourcePlugin {
  kind: FeedSpec['type'];
  fetch: (ctx: Ctx, persona: Persona, feed: FeedSpec) => Promise<FeedOutcome>;
}

/**
 * Feeds are plugins behind one interface:  fetch(ctx, persona, feed) → Document[]
 * Add a new kind by adding a file here and one line to PLUGINS.
 */
export async function fetchFeed(ctx: Ctx, persona: Persona, feed: FeedSpec): Promise<FeedOutcome> {
  if (feed.enabled === false) return { docs: [] };

  switch (feed.type) {
    case 'googlenews':
      return fetchGoogleNews(feed);

    case 'rss':
      return fetchRss(feed);

    case 'podcast':
      return fetchPodcast(feed);

    case 'blog':
      return fetchBlog(feed);

    case 'youtube':
      return fetchYouTube(feed);

    case 'rsshub': {
      const base = (ctx.env.RSSHUB_URL as string | undefined)?.replace(/\/+$/, '');
      if (!base) return { docs: [], error: 'RSSHUB_URL not set — skipped' };
      if (!feed.route) return { docs: [], error: 'missing rsshub route' };
      return fetchRss({ ...feed, url: `${base}${feed.route}` });
    }

    default:
      return { docs: [], error: `unknown feed type: ${(feed as FeedSpec).type}` };
  }
}

export function defaultFeedsFor(name: string): FeedSpec[] {
  return [
    { type: 'googlenews', query: `"${name}"`, label: 'google-news-en' },
    { type: 'googlenews', query: `"${name}"`, label: 'google-news-ar' },
  ];
}
