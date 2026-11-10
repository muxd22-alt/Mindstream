import { useEffect, useState } from 'react';
import { api, tg } from './api';
import type { Bootstrap } from './types';
import DebateTab from './components/DebateTab';
import PersonasTab from './components/PersonasTab';
import SourcesTab from './components/SourcesTab';
import HashtagsTab from './components/HashtagsTab';
import SettingsTab from './components/SettingsTab';

type Tab = 'debate' | 'personas' | 'sources' | 'hashtags' | 'settings';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'debate', label: 'Debate', icon: '💬' },
  { id: 'personas', label: 'Personas', icon: '👥' },
  { id: 'sources', label: 'Sources', icon: '📚' },
  { id: 'hashtags', label: 'Hashtags', icon: '#️⃣' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
];

export default function App() {
  const [tab, setTab] = useState<Tab>('debate');
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    try {
      setError(null);
      const data = await api.bootstrap();
      setBoot(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const webapp = tg();
    webapp?.ready();
    webapp?.expand();
    webapp?.MainButton?.hide();
    try {
      webapp?.setHeaderColor?.('#0b0f14');
      webapp?.setBackgroundColor?.('#0b0f14');
    } catch {
      /* not supported */
    }
    void load();
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const personas = boot?.personas ?? [];
  const user = tg()?.initDataUnsafe?.user;

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>Council</h1>
          <p className="muted small">
            {user?.first_name ? `${user.first_name} · ` : ''}
            {boot ? `${personas.filter((p) => p.enabled).length} personas · ${boot.quota.formatted}` : 'loading…'}
          </p>
        </div>
        <button className="ghost icon" onClick={() => void load()} title="Refresh">
          ↻
        </button>
      </header>

      {notice && <div className="toast">{notice}</div>}
      {loading && <div className="center"><div className="spinner" /></div>}

      {!loading && error && (
        <div className="panel error-panel">
          <h3>Could not load Council</h3>
          <p className="muted">{error}</p>
          <p className="muted small">
            Open this page from the bot's menu button. If you are testing locally, set
            <code> MINIAPP_DEV_BYPASS=1</code> in <code>.dev.vars</code>.
          </p>
          <button onClick={() => void load()}>Retry</button>
        </div>
      )}

      {!loading && boot && (
        <main className="content">
          {tab === 'debate' && <DebateTab personas={personas} onNotice={setNotice} onRefreshBoot={load} />}
          {tab === 'personas' && (
            <PersonasTab personas={personas} drafts={boot.drafts} onNotice={setNotice} onChanged={load} />
          )}
          {tab === 'sources' && <SourcesTab personas={personas} onNotice={setNotice} />}
          {tab === 'hashtags' && <HashtagsTab onNotice={setNotice} />}
          {tab === 'settings' && (
            <SettingsTab
              initial={boot.settings}
              models={boot.models}
              lastModel={boot.lastModel ?? null}
              onNotice={setNotice}
            />
          )}
        </main>
      )}

      <nav className="tabbar">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'tab active' : 'tab'} onClick={() => setTab(t.id)}>
            <span className="tab-icon">{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
