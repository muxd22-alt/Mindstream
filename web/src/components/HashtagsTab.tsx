import { useEffect, useState } from 'react';
import { api, haptic } from '../api';
import type { HashtagRow } from '../types';
import { Empty, Spinner } from './ui';
import { timeAgo } from './labels';

interface Props {
  onNotice: (s: string) => void;
}

export default function HashtagsTab({ onNotice }: Props) {
  const [tags, setTags] = useState<HashtagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [custom, setCustom] = useState('');

  async function load() {
    setLoading(true);
    try {
      const res = await api.hashtags();
      setTags(res.hashtags);
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function dig(raw: string) {
    const value = raw.trim();
    if (!value) return;
    try {
      haptic('light');
      await api.dig(value);
      onNotice(`Scout is digging into ${value}… a mini-debate will follow.`);
      setTimeout(() => void load(), 5000);
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="stack">
      <div className="panel">
        <h3>#️⃣ Dig into a topic</h3>
        <p className="muted small mt4">
          One tap runs Scout on the topic, stores fresh sources, then holds a mini-debate (2 model requests).
        </p>
        <div className="row gap6 mt8">
          <input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="#saudi_mortgage_sama or any keywords"
            onKeyDown={(e) => {
              if (e.key === 'Enter') void dig(custom);
            }}
          />
          <button onClick={() => void dig(custom)} disabled={!custom.trim()}>
            Dig
          </button>
        </div>
      </div>

      {loading && <div className="center"><Spinner /></div>}

      {!loading && !tags.length && (
        <Empty>No hashtags yet. Every finished debate produces five, and they show up here.</Empty>
      )}

      <div className="tag-grid">
        {tags.map((t) => (
          <button key={t.tag} className="tag-card" onClick={() => void dig(t.tag)}>
            <span className="tag-name">{t.tag}</span>
            <span className="muted tiny">
              {t.uses}× · {timeAgo(t.last_used_at)}
            </span>
          </button>
        ))}
      </div>

      {tags.length > 0 && (
        <button className="ghost" onClick={() => void load()}>
          Refresh
        </button>
      )}
    </div>
  );
}
