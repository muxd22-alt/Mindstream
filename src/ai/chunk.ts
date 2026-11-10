import { normalizeWs, splitSentences, truncate } from '../util/text';

export interface TextChunk {
  content: string;
  tokens: number;
}

/**
 * Rough multilingual token estimate. Arabic runs ~2.2 chars/token, English ~4.
 * Using 3 chars/token is deliberately conservative.
 */
export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3);
}

/** ~800 tokens per chunk with a small overlap, split on paragraph boundaries. */
export function chunkText(
  raw: string,
  opts: { maxChars?: number; overlapChars?: number } = {},
): TextChunk[] {
  const maxChars = opts.maxChars ?? 2400;
  const overlap = opts.overlapChars ?? 240;
  const text = normalizeWs(raw);
  if (!text) return [];
  if (text.length <= maxChars) return [{ content: text, tokens: estimateTokens(text) }];

  const paragraphs = text.split(/\n{2,}/).flatMap((p) => (p.length > maxChars ? splitSentences(p) : [p]));

  const chunks: string[] = [];
  let buf = '';
  const flush = () => {
    const t = buf.trim();
    if (t.length > 40) chunks.push(t);
    buf = '';
  };

  for (const part of paragraphs) {
    const piece = part.trim();
    if (!piece) continue;
    if (buf.length + piece.length + 2 <= maxChars) {
      buf += (buf ? '\n\n' : '') + piece;
      continue;
    }
    flush();
    if (piece.length <= maxChars) {
      buf = piece;
      continue;
    }
    // Hard split a single oversized sentence.
    let rest = piece;
    while (rest.length > maxChars) {
      const cut = rest.lastIndexOf(' ', maxChars);
      const end = cut > maxChars * 0.6 ? cut : maxChars;
      chunks.push(rest.slice(0, end).trim());
      rest = rest.slice(Math.max(0, end - overlap));
    }
    buf = rest;
  }
  flush();

  if (overlap > 0 && chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const tail = truncate(chunks[i - 1].slice(-overlap), overlap, '');
      if (tail && !chunks[i].startsWith(tail.slice(0, 40))) {
        chunks[i] = `${tail} ${chunks[i]}`.trim();
      }
    }
  }

  return chunks.map((c) => ({ content: c, tokens: estimateTokens(c) }));
}
