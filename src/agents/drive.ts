import type { Env } from '../types';

/**
 * Google Drive upload without the SDK: refresh-token → access token, then a
 * multipart upload converted to a Google Doc so NotebookLM can ingest it in
 * one tap. Entirely optional — the Telegram .md file always works.
 */
export async function uploadGoogleDoc(env: Env, name: string, html: string): Promise<string | null> {
  const folderId = env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    return null;
  }

  const token = await accessToken(env);
  if (!token) return null;

  const boundary = `council_${crypto.randomUUID().replace(/-/g, '')}`;
  const metadata = JSON.stringify({
    name,
    mimeType: 'application/vnd.google-apps.document',
    parents: [folderId],
  });
  const body =
    `--${boundary}\r\n` +
    'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
    `${metadata}\r\n` +
    `--${boundary}\r\n` +
    'Content-Type: text/html; charset=UTF-8\r\n\r\n' +
    `${html}\r\n` +
    `--${boundary}--`;

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink',
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/related; boundary=${boundary}`,
      },
      body,
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!res.ok) {
    console.error('Drive upload failed', res.status, (await res.text()).slice(0, 300));
    return null;
  }
  const json = (await res.json()) as { webViewLink?: string; id?: string };
  return json.webViewLink ?? (json.id ? `https://docs.google.com/document/d/${json.id}` : null);
}

async function accessToken(env: Env): Promise<string | null> {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
    refresh_token: env.GOOGLE_REFRESH_TOKEN ?? '',
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    console.error('Google token exchange failed', res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const json = (await res.json()) as { access_token?: string };
  return json.access_token ?? null;
}

export async function driveConfigured(env: Env): Promise<boolean> {
  return Boolean(env.GOOGLE_DRIVE_FOLDER_ID && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

/** Tiny Markdown → HTML for the Drive copy (headings, lists, tables, links, bold). */
export function markdownToHtml(md: string, title: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) =>
    esc(s)
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');

  const lines = md.split('\n');
  const out: string[] = [`<html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>`];
  let inList = false;
  let inTable = false;

  const closeList = () => {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      out.push('</table>');
      inTable = false;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      closeList();
      closeTable();
      continue;
    }
    if (/^\|/.test(line)) {
      if (/^\|[\s:|-]+\|?$/.test(line)) continue;
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (!inTable) {
        out.push('<table border="1" cellpadding="6" cellspacing="0">');
        inTable = true;
        out.push(`<tr>${cells.map((c) => `<th>${inline(c)}</th>`).join('')}</tr>`);
      } else {
        out.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      }
      continue;
    }
    closeTable();
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    const numbered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (numbered) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${inline(numbered[1])}</li>`);
      continue;
    }
    closeList();
    if (line.startsWith('>')) {
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`);
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  closeTable();
  out.push('</body></html>');
  return out.join('\n');
}

export function packTitle(question: string): string {
  return question.replace(/\s+/g, ' ').slice(0, 70);
}
