import { decodeEntities, htmlToText, normalizeWs } from '../util/text';

export interface FeedItem {
  title: string;
  link: string;
  published: string | null;
  summary: string;
  contentHtml: string;
  guid: string | null;
  audioUrl?: string | null;
}

export interface ParsedFeed {
  title: string;
  items: FeedItem[];
}

/** Tolerant RSS 2.0 / Atom / RDF reader. Workers have no DOMParser, so this is regex based. */
export function parseFeed(xml: string): ParsedFeed {
  const cleaned = stripBom(xml);
  const feedTitle = textOf(firstMatch(cleaned, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? '');
  const blocks = collectBlocks(cleaned);
  const items: FeedItem[] = [];

  for (const block of blocks) {
    const title = textOf(firstMatch(block, /<title[^>]*>([\s\S]*?)<\/title>/i) ?? '');
    const link = extractLink(block);
    if (!link) continue;

    const publishedRaw =
      firstMatch(block, /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) ??
      firstMatch(block, /<published[^>]*>([\s\S]*?)<\/published>/i) ??
      firstMatch(block, /<updated[^>]*>([\s\S]*?)<\/updated>/i) ??
      firstMatch(block, /<dc:date[^>]*>([\s\S]*?)<\/dc:date>/i) ??
      firstMatch(block, /<created[^>]*>([\s\S]*?)<\/created>/i) ??
      null;

    const contentHtml =
      firstMatch(block, /<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i) ??
      firstMatch(block, /<content[^>]*>([\s\S]*?)<\/content>/i) ??
      firstMatch(block, /<description[^>]*>([\s\S]*?)<\/description>/i) ??
      firstMatch(block, /<summary[^>]*>([\s\S]*?)<\/summary>/i) ??
      '';

    const audioUrl =
      firstAttr(block, /<enclosure[^>]*url=["']([^"']+)["']/i) ??
      firstAttr(block, /<media:content[^>]*url=["']([^"']+)["']/i) ??
      null;

    items.push({
      title: normalizeWs(textOf(title)) || 'Untitled',
      link,
      published: parseDate(publishedRaw),
      summary: normalizeWs(htmlToText(unwrapCdata(contentHtml))).slice(0, 1200),
      contentHtml: unwrapCdata(contentHtml),
      guid: textOf(firstMatch(block, /<guid[^>]*>([\s\S]*?)<\/guid>/i) ?? firstMatch(block, /<id[^>]*>([\s\S]*?)<\/id>/i) ?? '') || null,
      audioUrl,
    });
  }

  return { title: normalizeWs(feedTitle) || 'Feed', items };
}

function collectBlocks(xml: string): string[] {
  const blocks: string[] = [];
  for (const tag of ['item', 'entry']) {
    const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) blocks.push(m[1]);
  }
  return blocks;
}

function extractLink(block: string): string | null {
  const href = firstAttr(block, /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (href) return decodeEntities(href.trim());
  const anyHref = firstAttr(block, /<link[^>]*href=["']([^"']+)["']/i);
  if (anyHref) return decodeEntities(anyHref.trim());
  const inner = firstMatch(block, /<link>([\s\S]*?)<\/link>/i);
  if (inner) return decodeEntities(textOf(inner));
  const guid = firstMatch(block, /<guid[^>]*isPermaLink=["']true["'][^>]*>([\s\S]*?)<\/guid>/i);
  if (guid) return decodeEntities(textOf(guid));
  return null;
}

function firstMatch(text: string, re: RegExp): string | null {
  const m = text.match(re);
  return m?.[1] ?? null;
}

function firstAttr(text: string, re: RegExp): string | null {
  return text.match(re)?.[1] ?? null;
}

function textOf(s: string): string {
  return decodeEntities(unwrapCdata(s).replace(/<!\[CDATA\[|\]\]>/g, '')).trim();
}

function unwrapCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

export function parseDate(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = textOf(raw);
  const t = Date.parse(cleaned);
  if (Number.isFinite(t)) return new Date(t).toISOString();
  // Some feeds use "2024-05-01 10:00:00"
  const alt = Date.parse(cleaned.replace(' ', 'T'));
  return Number.isFinite(alt) ? new Date(alt).toISOString() : null;
}

/** Extract article links from an HTML index page (for blogs without a feed). */
export function extractLinks(html: string, baseUrl: string): { url: string; text: string }[] {
  const base = safeUrl(baseUrl);
  const out: { url: string; text: string }[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const rawHref = decodeEntities(m[1].trim());
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('mailto:')) continue;
    let abs: URL;
    try {
      abs = new URL(rawHref, base ?? baseUrl);
    } catch {
      continue;
    }
    if (!abs.protocol.startsWith('http')) continue;
    if (base && abs.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    const path = abs.pathname;
    if (/^\/(tag|tags|category|categories|author|authors|about|contact|privacy|terms|login|signup|subscribe|feed|rss|search|archive|page)\b/i.test(path)) continue;
    if (/\.(png|jpe?g|gif|svg|webp|pdf|zip|mp3|mp4|css|js)$/i.test(path)) continue;
    if (path.split('/').filter(Boolean).length === 0) continue;
    abs.hash = '';
    const key = abs.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const text = normalizeWs(htmlToText(m[2] ?? '')).slice(0, 200);
    out.push({ url: key, text });
  }
  return out;
}

/** Pull readable text out of an article page. */
export function extractArticle(html: string): { title: string; text: string; published: string | null } {
  const ogTitle =
    firstAttr(html, /<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ??
    firstAttr(html, /<meta[^>]*name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i);
  const h1 = firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);

  const published =
    firstAttr(html, /<meta[^>]*property=["']article:published_time["'][^>]*content=["']([^"']+)["']/i) ??
    firstAttr(html, /<meta[^>]*name=["']date["'][^>]*content=["']([^"']+)["']/i) ??
    firstAttr(html, /<time[^>]*datetime=["']([^"']+)["']/i);

  const body =
    firstMatch(html, /<article[^>]*>([\s\S]*?)<\/article>/i) ??
    firstMatch(html, /<main[^>]*>([\s\S]*?)<\/main>/i) ??
    firstMatch(html, /<div[^>]*class=["'][^"']*(?:post|entry|article)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) ??
    html.replace(/<nav[\s\S]*?<\/nav>/gi, ' ').replace(/<footer[\s\S]*?<\/footer>/gi, ' ');

  const text = normalizeWs(htmlToText(body));
  return {
    title: normalizeWs(htmlToText(ogTitle ?? h1 ?? '')) || 'Untitled',
    text,
    published: parseDate(published),
  };
}

function safeUrl(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}
