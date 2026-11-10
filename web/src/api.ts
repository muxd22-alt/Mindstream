import type {
  BeliefRow,
  BeliefTopic,
  Bootstrap,
  Debate,
  DocRow,
  Draft,
  FeedRow,
  HashtagRow,
  Message,
  Persona,
  Scribe,
  Settings,
} from './types';

declare global {
  interface Window {
    Telegram?: {
      WebApp: {
        initData: string;
        initDataUnsafe?: { user?: { id: number; first_name?: string } };
        ready: () => void;
        expand: () => void;
        close: () => void;
        colorScheme?: string;
        themeParams?: Record<string, string>;
        HapticFeedback?: { impactOccurred: (s: string) => void; notificationOccurred: (s: string) => void };
        MainButton?: { hide: () => void; show: () => void; setText: (t: string) => void };
        setHeaderColor?: (c: string) => void;
        setBackgroundColor?: (c: string) => void;
        openLink?: (u: string) => void;
      };
    };
  }
}

export const tg = () => window.Telegram?.WebApp;

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const initData = tg()?.initData ?? '';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(initData ? { 'x-telegram-init-data': initData } : {}),
    'x-internal-token': (import.meta.env.VITE_INTERNAL_TOKEN as string) ?? '',
  };
  const res = await fetch(`/api${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string>) } });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const message = (json as { error?: string } | null)?.error ?? `HTTP ${res.status}`;
    throw new ApiError(message, res.status);
  }
  return json as T;
}

export const api = {
  bootstrap: () => request<Bootstrap>('/bootstrap'),

  debates: () => request<{ debates: Debate[] }>('/debates?limit=30'),
  debate: (id: string) =>
    request<{ debate: Debate; scribe: Scribe | null; messages: Message[] }>(`/debates/${id}`),
  ask: (question: string, personas?: string[]) =>
    request<{ debate: Debate }>('/debates', { method: 'POST', body: JSON.stringify({ question, personas }) }),
  more: (id: string) => request<{ job_id: string }>(`/debates/${id}/more`, { method: 'POST' }),
  me: (id: string, text: string) =>
    request<{ job_id: string }>(`/debates/${id}/me`, { method: 'POST', body: JSON.stringify({ text }) }),
  notebook: (id: string) => request<{ job_id: string }>(`/debates/${id}/notebook`, { method: 'POST' }),
  end: (id: string) => request<{ job_id: string }>(`/debates/${id}/end`, { method: 'POST' }),
  notebookMarkdown: (id: string) =>
    request<{ filename: string; markdown: string; sources: string }>(`/debates/${id}/notebook`),

  personas: () => request<{ personas: Persona[] }>('/personas'),
  persona: (id: string) => request<{ persona: Persona; yaml: string }>(`/personas/${id}`),
  updatePersona: (id: string, patch: { enabled?: boolean; yaml?: string }) =>
    request<{ persona: Persona }>(`/personas/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  clonePersona: (id: string, newId: string) =>
    request<{ persona: Persona }>(`/personas/${id}/clone`, { method: 'POST', body: JSON.stringify({ new_id: newId }) }),
  importPersona: (yaml: string) =>
    request<{ persona: Persona; updated: boolean }>('/personas/import', { method: 'POST', body: JSON.stringify({ yaml }) }),
  beliefs: (id: string, topic?: string) =>
    request<{ topics: BeliefTopic[] }>(`/personas/${id}/beliefs${topic ? `?topic=${encodeURIComponent(topic)}` : ''}`),

  sources: (persona?: string, since?: string) => {
    const p = new URLSearchParams();
    if (persona) p.set('persona', persona);
    if (since) p.set('since', since);
    p.set('limit', '60');
    return request<{ feeds: FeedRow[]; documents: DocRow[] }>(`/sources?${p.toString()}`);
  },

  hashtags: () => request<{ hashtags: HashtagRow[] }>('/hashtags'),
  dig: (raw: string) => request<{ job_id: string }>('/dig', { method: 'POST', body: JSON.stringify({ raw }) }),

  drafts: () => request<{ drafts: Draft[] }>('/drafts'),
  approveDraft: (id: string) => request<{ persona: Persona }>(`/drafts/${id}/approve`, { method: 'POST' }),
  rejectDraft: (id: string) => request<{ ok: boolean }>(`/drafts/${id}/reject`, { method: 'POST' }),

  settings: () => request<{ settings: Settings; models: string[] }>('/settings'),
  saveSettings: (patch: Partial<Settings>) =>
    request<{ ok: boolean }>('/settings', { method: 'PUT', body: JSON.stringify(patch) }),
};

export function haptic(kind: 'light' | 'success' | 'error' = 'light') {
  const h = tg()?.HapticFeedback;
  if (!h) return;
  if (kind === 'light') h.impactOccurred('light');
  else h.notificationOccurred(kind === 'success' ? 'success' : 'error');
}

export { ApiError };
