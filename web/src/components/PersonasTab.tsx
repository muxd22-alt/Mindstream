import { useEffect, useMemo, useState } from 'react';
import { api, haptic } from '../api';
import type { BeliefTopic, Draft, Persona } from '../types';
import { Badge, Empty, Spinner } from './ui';
import { shortDate } from './labels';

interface Props {
  personas: Persona[];
  drafts: Draft[];
  onNotice: (s: string) => void;
  onChanged: () => Promise<void>;
}

export default function PersonasTab({ personas, drafts, onNotice, onChanged }: Props) {
  const [selected, setSelected] = useState<string | null>(personas[0]?.id ?? null);
  const [yaml, setYaml] = useState('');
  const [loadedYaml, setLoadedYaml] = useState('');
  const [topics, setTopics] = useState<BeliefTopic[]>([]);
  const [topicFilter, setTopicFilter] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [cloneId, setCloneId] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importYaml, setImportYaml] = useState('');
  const [showDrafts, setShowDrafts] = useState(drafts.length > 0);

  const persona = useMemo(() => personas.find((p) => p.id === selected) ?? null, [personas, selected]);

  useEffect(() => {
    if (!selected && personas[0]) setSelected(personas[0].id);
  }, [personas, selected]);

  useEffect(() => {
    if (!selected) return;
    let alive = true;
    setLoading(true);
    Promise.all([api.persona(selected), api.beliefs(selected)])
      .then(([p, b]) => {
        if (!alive) return;
        setYaml(p.yaml);
        setLoadedYaml(p.yaml);
        setTopics(b.topics);
      })
      .catch((e) => onNotice(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [selected, onNotice]);

  async function save() {
    if (!selected || saving) return;
    setSaving(true);
    try {
      await api.updatePersona(selected, { yaml });
      setLoadedYaml(yaml);
      haptic('success');
      onNotice('Saved.');
      await onChanged();
    } catch (e) {
      haptic('error');
      onNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(p: Persona) {
    try {
      await api.updatePersona(p.id, { enabled: !p.enabled });
      haptic('light');
      await onChanged();
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function clone() {
    if (!selected || !cloneId.trim()) return;
    try {
      await api.clonePersona(selected, cloneId.trim());
      setCloneId('');
      haptic('success');
      onNotice('Cloned. Edit the new persona below.');
      await onChanged();
    } catch (e) {
      haptic('error');
      onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function importYamlNow() {
    if (!importYaml.trim()) return;
    try {
      const res = await api.importPersona(importYaml);
      setImportYaml('');
      setShowImport(false);
      setSelected(res.persona.id);
      haptic('success');
      onNotice(res.updated ? 'Persona updated.' : 'Persona imported.');
      await onChanged();
    } catch (e) {
      haptic('error');
      onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function decide(draft: Draft, approve: boolean) {
    try {
      if (approve) await api.approveDraft(draft.id);
      else await api.rejectDraft(draft.id);
      haptic('success');
      onNotice(approve ? 'Draft approved — it can debate now.' : 'Draft rejected.');
      await onChanged();
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  function download() {
    if (!persona) return;
    const blob = new Blob([yaml], { type: 'text/yaml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${persona.id}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const visibleTopics = topicFilter
    ? topics.filter(
        (t) =>
          t.topic_key.includes(topicFilter.toLowerCase()) ||
          t.topic.toLowerCase().includes(topicFilter.toLowerCase()),
      )
    : topics;

  return (
    <div className="stack">
      {drafts.length > 0 && (
        <div className="panel drafts">
          <div className="row between">
            <h3>🧪 Draft personas ({drafts.length})</h3>
            <button className="ghost small" onClick={() => setShowDrafts((v) => !v)}>
              {showDrafts ? 'Hide' : 'Show'}
            </button>
          </div>
          {showDrafts &&
            drafts.map((d) => (
              <div key={d.id} className="draft">
                <div className="row between wrap">
                  <strong>{d.payload.name ?? d.persona_id}</strong>
                  <span className="muted tiny">{shortDate(d.created_at)}</span>
                </div>
                <pre className="yaml-preview">{d.yaml.slice(0, 600)}</pre>
                <div className="row gap6">
                  <button className="small" onClick={() => void decide(d, true)}>Approve</button>
                  <button className="ghost small" onClick={() => void decide(d, false)}>Reject</button>
                </div>
              </div>
            ))}
        </div>
      )}

      <div className="panel">
        <div className="row between">
          <h3>👥 Personas</h3>
          <button className="ghost small" onClick={() => setShowImport((v) => !v)}>
            {showImport ? 'Close' : 'Import YAML'}
          </button>
        </div>

        {showImport && (
          <div className="block">
            <textarea
              rows={8}
              value={importYaml}
              onChange={(e) => setImportYaml(e.target.value)}
              placeholder="Paste persona YAML here…"
            />
            <div className="row gap6 mt8">
              <button className="small" onClick={() => void importYamlNow()} disabled={!importYaml.trim()}>
                Import
              </button>
              <span className="muted tiny">Adding a persona never needs a code change.</span>
            </div>
          </div>
        )}

        <div className="persona-list">
          {personas.map((p) => (
            <div key={p.id} className={`persona-row ${selected === p.id ? 'active' : ''}`}>
              <button className="persona-main" onClick={() => setSelected(p.id)}>
                <span className="avatar">{p.emoji}</span>
                <span>
                  <span className="name">{p.display_name}</span>
                  <span className="muted tiny block">
                    {p.id} · {p.beliefs ?? 0} beliefs · {p.documents ?? 0} docs
                  </span>
                </span>
              </button>
              <button className={`switch ${p.enabled ? 'on' : ''}`} onClick={() => void toggle(p)} aria-label="toggle">
                <span />
              </button>
            </div>
          ))}
          {!personas.length && <Empty>No personas yet. Import one, or ask the bot <code>/persona add …</code></Empty>}
        </div>
      </div>

      {persona && (
        <div className="panel">
          <div className="row between wrap">
            <h3>
              {persona.emoji} {persona.display_name}
            </h3>
            <div className="row gap6">
              <Badge tone={persona.enabled ? 'ok' : 'warn'}>{persona.enabled ? 'on' : 'off'}</Badge>
              <Badge>{persona.origin}</Badge>
            </div>
          </div>

          {loading ? (
            <div className="center"><Spinner /></div>
          ) : (
            <>
              <textarea
                className="yaml-editor"
                rows={22}
                value={yaml}
                onChange={(e) => setYaml(e.target.value)}
                spellCheck={false}
              />
              <div className="row between wrap mt8">
                <span className="muted tiny">{yaml !== loadedYaml ? 'Unsaved changes' : 'Saved'}</span>
                <div className="row gap6">
                  <button className="ghost small" onClick={download}>Download</button>
                  <button className="small" onClick={() => void save()} disabled={yaml === loadedYaml || saving}>
                    {saving ? 'Saving…' : 'Save YAML'}
                  </button>
                </div>
              </div>

              <div className="block">
                <h4>Clone</h4>
                <div className="row gap6">
                  <input
                    value={cloneId}
                    onChange={(e) => setCloneId(e.target.value)}
                    placeholder={`${persona.id}_2020`}
                  />
                  <button className="small" onClick={() => void clone()} disabled={!cloneId.trim()}>
                    Clone
                  </button>
                </div>
                <p className="muted tiny mt4">
                  A clone is a separate persona with its own beliefs and memory.
                </p>
              </div>
            </>
          )}

          <div className="block">
            <div className="row between wrap">
              <h4>🧠 Belief timeline ({topics.length})</h4>
              <input
                className="narrow"
                value={topicFilter}
                onChange={(e) => setTopicFilter(e.target.value)}
                placeholder="filter topic"
              />
            </div>
            {visibleTopics.length === 0 && (
              <p className="muted small">
                No beliefs stored yet. Run <code>/update {persona.id}</code> in Telegram.
              </p>
            )}
            {visibleTopics.slice(0, 25).map((t) => (
              <div key={t.topic_key} className="topic">
                <div className="topic-head">{t.topic}</div>
                {t.current ? (
                  <div className="stance current">
                    <span>{t.current.stance}</span>
                    <span className="muted tiny">
                      since {shortDate(t.current.created_at)}
                      {t.current.is_quote ? ' · quote' : ''} · conf {t.current.confidence.toFixed(1)}
                      {t.current.source_url ? (
                        <>
                          {' · '}
                          <a href={t.current.source_url} target="_blank" rel="noreferrer noopener">
                            source
                          </a>
                        </>
                      ) : null}
                    </span>
                  </div>
                ) : (
                  <div className="muted small">superseded</div>
                )}
                {t.history.length > 0 && (
                  <ol className="timeline">
                    {t.history.map((h) => (
                      <li key={h.id}>
                        <span className="muted tiny">
                          {shortDate(h.created_at)} → {shortDate(h.superseded_at)}
                        </span>
                        <span className="strike">{h.stance}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
