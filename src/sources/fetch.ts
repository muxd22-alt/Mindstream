// Fetch helper with timeouts and a polite UA. Uses the global fetch (Workers + Node).

export interface FetchTextResult {
  ok: boolean;
  status: number;
  text: string;
  contentType: string;
  finalUrl: string;
  error?: string;
}

const UA =
  'Mozilla/5.0 (compatible; CouncilBot/1.0; +https://github.com/muxd22-alt/council) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

export async function fetchText(
  url: string,
  opts: { timeoutMs?: number; headers?: Record<string, string>; maxBytes?: number } = {},
): Promise<FetchTextResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, */*;q=0.5',
        'accept-language': 'en,ar;q=0.8',
        ...opts.headers,
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return { ok: false, status: res.status, text: '', contentType: '', finalUrl: res.url, error: `HTTP ${res.status}` };
    }
    const maxBytes = opts.maxBytes ?? 2_500_000;
    const buf = await res.arrayBuffer();
    const slice = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
    return {
      ok: true,
      status: res.status,
      text: new TextDecoder('utf-8').decode(slice),
      contentType: res.headers.get('content-type') ?? '',
      finalUrl: res.url || url,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      text: '',
      contentType: '',
      finalUrl: url,
      error: e instanceof Error ? e.message.slice(0, 200) : String(e),
    };
  }
}

export async function fetchJson<T>(url: string, opts: { timeoutMs?: number; headers?: Record<string, string>; method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...opts.headers },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}
