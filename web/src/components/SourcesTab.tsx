import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { DocRow, FeedRow, Persona } from '../types';
import { Badge, Empty, Spinner } from './ui';
import { shortDate, timeAgo } from './labels';

interface Props {
  personas: Persona[];
  onNotice: (s: string) => void;
}

type Window = '7' | '30' | '90' | 'all';

export default function SourcesTab({ personas, onNotice }: Props) {
  const [persona, setPersona] = useState<string>('');
  const [since, setSince] = useState<Window>('30');
  const [docs, setDocs] = useState<DocRow[]>([]);
  const [feeds, setFeeds] = useState<FeedRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const sinceIso =
      since === 'all' ? undefined : new Date(Date.now() - Number(since) * 86400_000).toISOString().slice(0, 10);
    api
      .sources(persona || undefined, sinceIso)
      .then((res) => {
        if (!alive) return;
        setDocs(res.documents);
        setFeeds(res.feeds);
      })
      .catch((e) => onNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [persona, since, onNotice]);

  const byId = useMemo(() => new Map(personas.map((p) => [p.id, p])), [personas]);

  return (
    <div className="stack">
      <div className="panel">
        <h3>📚 Sources</h3>
        <div className="row gap6 mt8 wrap">
          <select value={persona} onChange={(e) => setPersona(e.target.value)}>
            <option value="">All personas</option>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.emoji} {p.display_name}
              </option>
            ))}
          </select>
          <select value={since} onChange={(e) => setSince(e.target.value as Window)}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="all">All time</option>
          </select>
        </div>
        <p className="muted tiny mt8">
          {feeds.length} feed(s) configured · {docs.length} document(s) shown. Scout adds these automatically every
          6 hours.
        </p>
      </div>

      {loading && <div className="center"><Spinner /></div>}

      {!loading && !docs.length && <Empty>No documents in this window. Run /update in Telegram.</Empty>}

      {docs.map((d) => (
        <a key={d.id} className="panel doc" href={d.url} target="_blank" rel="noreferrer noopener">
          <div className="row between wrap gap6">
            <span className="doc-title">{d.title || 'Untitled'}</span>
            <Badge>{d.kind}</Badge>
          </div>
          <div className="muted tiny mt4">
            {byId.get(d.persona_id)?.emoji} {byId.get(d.persona_id)?.display_name ?? d.persona_id} ·{' '}
            {shortDate(d.published_at ?? d.fetched_at)} · {Math.round(d.content_chars / 1000)}k chars · fetched{' '}
            {timeAgo(d.fetched_at)}
          </div>
        </a>
      ))}

      {feeds.length > 0 && (
        <div className="panel">
          <h4>Feeds</h4>
          <ul className="feed-list">
            {feeds.map((f) => (
              <li key={f.id}>
                <Badge>{f.kind}</Badge> <span className="muted small">{f.label}</span>
                {f.query ? <span className="muted tiny"> · {f.query}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
