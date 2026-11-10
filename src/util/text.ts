// Text helpers. Kept dependency-free so they run identically in the Worker and Node.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'",
  '#x27': "'",
  '#8217': '’',
  '#8216': '‘',
  '#8220': '“',
  '#8221': '”',
  '#8211': '–',
  '#8212': '—',
  '#8230': '…',
};

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
}

export function normalizeWs(s: string): string {
  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function htmlToText(html: string): string {
  return normalizeWs(decodeEntities(stripTags(html)));
}

export function truncate(s: string, max: number, suffix = '…'): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - suffix.length)).trimEnd() + suffix;
}

export function wordCount(s: string): number {
  const t = s.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/** Hard cap on words. Cuts on a sentence boundary when possible. */
export function limitWords(s: string, max: number): string {
  const words = s.trim().split(/\s+/);
  if (words.length <= max) return s.trim();
  const cut = words.slice(0, max).join(' ');
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('؟ '), cut.lastIndexOf('! '));
  if (lastStop > cut.length * 0.5) return cut.slice(0, lastStop + 1);
  return cut.replace(/[,;،]$/, '') + '…';
}

export function detectLang(text: string): 'ar' | 'en' {
  const arabic = (text.match(/[\u0600-\u06FF\u0750-\u077F]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return arabic > latin ? 'ar' : 'en';
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

/** Stable key for grouping beliefs about the same thing. */
export function topicKey(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .replace(/\b(the|a|an|of|on|for|in|and|about|ال)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'general';
}

export function cleanHashtag(raw: string): string | null {
  const t = raw.trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]+/gu, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  if (t.length < 2) return null;
  return '#' + t.toLowerCase().slice(0, 40);
}

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

export function jaccard(a: string, b: string): number {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

const NEGATIVE = /\b(no|not|never|against|oppose|opposed|reject|stop|harmful|bad|risky|shouldn'?t|won'?t|can'?t|refuse|skeptical|لا|ليس|ضد|يرفض|خطير|سيئ)\b/i;

export function polarityNegative(s: string): boolean {
  return NEGATIVE.test(s);
}

/**
 * Has the stance materially changed? Used to decide whether to create a new
 * belief row and supersede the old one.
 */
export function stanceChanged(oldStance: string, newStance: string): boolean {
  if (jaccard(oldStance, newStance) >= 0.62) return false;
  return true;
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?؟])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function uniqueBy<T>(arr: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of arr) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(items.length, 1)) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}
