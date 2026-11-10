export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const TRACKING = /^(utm_[a-z]+|fbclid|gclid|mc_cid|mc_eid|ref|ref_src|igshid|si|s)$/i;

/** Canonical URL used for dedupe. Drops tracking params, hash and trailing slash. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    const keep: [string, string][] = [];
    u.searchParams.forEach((v, k) => {
      if (!TRACKING.test(k)) keep.push([k, v]);
    });
    u.search = '';
    for (const [k, v] of keep.sort(([a], [b]) => a.localeCompare(b))) u.searchParams.append(k, v);
    let path = u.pathname.replace(/\/+$/, '');
    if (!path) path = '/';
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
