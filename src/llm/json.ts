/** Robust JSON extraction from small models that love to add prose. */

export function extractJson<T>(raw: string): T | null {
  if (!raw) return null;
  let text = raw.trim();

  // Strip code fences.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();

  // Trim to the outermost JSON value.
  const startObj = text.indexOf('{');
  const startArr = text.indexOf('[');
  let start = -1;
  if (startObj === -1) start = startArr;
  else if (startArr === -1) start = startObj;
  else start = Math.min(startObj, startArr);
  if (start === -1) return null;

  const open = text[start];
  const close = open === '{' ? '}' : ']';
  const end = findMatching(text, start, open, close);
  if (end === -1) return null;

  const candidate = text.slice(start, end + 1);
  const attempts = [candidate, repair(candidate)];
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as T;
    } catch {
      // try next
    }
  }
  return null;
}

function findMatching(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function repair(text: string): string {
  return text
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[ \t]*\r?\n[ \t]*/g, ' ')
    .replace(/\/\/[^\n"]*/g, '');
}

export function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (v && typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    for (const key of ['rounds', 'replies', 'reviews', 'ranking', 'beliefs', 'items', 'results', 'data', 'verdicts']) {
      if (Array.isArray(obj[key])) return obj[key] as T[];
    }
  }
  return [];
}

export function str(v: unknown, fallback = ''): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return fallback;
}

export function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = str(v).toLowerCase();
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}
