import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, haptic } from '../api';
import type { Debate, Message, Persona, Scribe } from '../types';
import { Badge, Chip, Empty, Spinner } from './ui';
import { shortDate, timeAgo } from './labels';

interface Props {
  personas: Persona[];
  onNotice: (s: string) => void;
  onRefreshBoot: () => Promise<void>;
}

interface Detail {
  debate: Debate;
  scribe: Scribe | null;
  messages: Message[];
}

export default function DebateTab({ personas, onNotice, onRefreshBoot }: Props) {
  const [debates, setDebates] = useState<Debate[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [meText, setMeText] = useState('');
  const [showMe, setShowMe] = useState(false);
  const [loading, setLoading] = useState(true);
  const selectedRef = useRef<string | null>(null);

  selectedRef.current = selected;

  const loadList = useCallback(async (keep?: string) => {
    const { debates: list } = await api.debates();
    setDebates(list);
    const target = keep ?? selectedRef.current ?? list[0]?.id ?? null;
    if (target && target !== selectedRef.current) setSelected(target);
    return { list, target };
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    const d = await api.debate(id);
    setDetail(d);
    return d;
  }, []);

  const refresh = useCallback(
    async (keep?: string) => {
      try {
        const { target } = await loadList(keep);
        if (target) await loadDetail(target);
      } catch (e) {
        onNotice(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [loadList, loadDetail, onNotice],
  );

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected) return;
    void loadDetail(selected).catch(() => undefined);
  }, [selected, loadDetail]);

  // Poll while the selected debate is still running.
  useEffect(() => {
    const status = detail?.debate.status;
    const id = selected;
    if (!id || status === 'done' || status === 'error') return;
    const t = setInterval(() => {
      void loadDetail(id).catch(() => undefined);
      void loadList(id).catch(() => undefined);
    }, 3500);
    return () => clearInterval(t);
  }, [detail?.debate.status, selected, loadDetail, loadList]);

  async function ask() {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    haptic('light');
    try {
      const { debate } = await api.ask(q);
      setQuestion('');
      setSelected(debate.id);
      setDetail({ debate, scribe: null, messages: [] });
      onNotice('Council is deliberating — this can take a minute.');
      await onRefreshBoot();
      setTimeout(() => void refresh(debate.id), 2500);
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function more() {
    if (!selected) return;
    try {
      await api.more(selected);
      onNotice('One more round…');
      setTimeout(() => void refresh(selected), 1500);
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function join() {
    if (!selected || !meText.trim()) return;
    try {
      await api.me(selected, meText.trim());
      setMeText('');
      setShowMe(false);
      onNotice('You are in — letting them react.');
      setTimeout(() => void refresh(selected), 1500);
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function notebook() {
    if (!selected) return;
    try {
      await api.notebook(selected);
      onNotice('NotebookLM pack is being built and sent to Telegram.');
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function downloadPack() {
    if (!selected) return;
    try {
      const pack = await api.notebookMarkdown(selected);
      const blob = new Blob([pack.markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = pack.filename;
      a.click();
      URL.revokeObjectURL(url);
      onNotice('Downloaded the NotebookLM pack.');
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function endThread() {
    if (!selected) return;
    try {
      await api.end(selected);
      onNotice('Scribe is writing the final summary and pack.');
      setTimeout(() => void refresh(selected), 2500);
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  async function dig(tag: string) {
    try {
      haptic('light');
      await api.dig(tag);
      onNotice(`Digging into ${tag}…`);
      setTimeout(() => void refresh(), 4000);
    } catch (e) {
      onNotice(e instanceof Error ? e.message : String(e));
    }
  }

  const byId = useMemo(() => new Map(personas.map((p) => [p.id, p])), [personas]);
  const rounds = useMemo(() => {
    if (!detail) return [] as { round: number; messages: Message[] }[];
    const map = new Map<number, Message[]>();
    for (const m of detail.messages) {
      if (m.role !== 'persona' && m.role !== 'user') continue;
      const list = map.get(m.round) ?? [];
      list.push(m);
      map.set(m.round, list);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([round, messages]) => ({ round, messages }));
  }, [detail]);

  return (
    <div className="stack">
      <div className="panel composer">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask the council anything… (Arabic or English)"
          rows={3}
          maxLength={800}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void ask();
          }}
        />
        <div className="row between">
          <span className="muted tiny">{question.length}/800 · 3 calls default, 5 in live mode</span>
          <button onClick={() => void ask()} disabled={!question.trim() || busy}>
            {busy ? 'Sending…' : 'Ask council'}
          </button>
        </div>
      </div>

      {debates.length > 0 && (
        <div className="rail">
          {debates.map((d) => (
            <button
              key={d.id}
              className={`rail-item ${selected === d.id ? 'active' : ''}`}
              onClick={() => {
                setSelected(d.id);
                haptic('light');
              }}
            >
              <span className="rail-q">{d.question}</span>
              <span className="muted tiny">
                {timeAgo(d.created_at)} · {d.status}
              </span>
            </button>
          ))}
        </div>
      )}

      {loading && <div className="center"><Spinner /></div>}

      {!loading && !detail && (
        <Empty>
          No debates yet. Ask a question above, or send one to the bot on Telegram.
          <br />
          Every persona answer is a simulation with stored sources.
        </Empty>
      )}

      {detail && (
        <>
          <div className="panel debate-head">
            <h2>{detail.debate.question}</h2>
            <div className="row wrap gap6 tiny muted">
              <Badge tone={detail.debate.status === 'done' ? 'ok' : 'warn'}>{detail.debate.status}</Badge>
              <span>{shortDate(detail.debate.created_at)}</span>
              <span>· {detail.debate.lang.toUpperCase()}</span>
              <span>· {detail.debate.mode}</span>
              <span>· {detail.debate.persona_ids.length} personas</span>
            </div>
            <div className="row wrap gap6 mt8">
              <button className="ghost small" onClick={() => void more()}>🔁 Another round</button>
              <button className="ghost small" onClick={() => setShowMe((v) => !v)}>🙋 Join</button>
              <button className="ghost small" onClick={() => void endThread()}>📝 End &amp; summarize</button>
              <button className="ghost small" onClick={() => void notebook()}>📓 NotebookLM</button>
              <button className="ghost small" onClick={() => void downloadPack()}>⬇️ .md</button>
            </div>
            {showMe && (
              <div className="row gap6 mt8">
                <input
                  value={meText}
                  onChange={(e) => setMeText(e.target.value)}
                  placeholder="Your point…"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void join();
                  }}
                />
                <button className="small" onClick={() => void join()} disabled={!meText.trim()}>
                  Send
                </button>
              </div>
            )}
          </div>

          {detail.debate.status !== 'done' && (
            <div className="panel running">
              <Spinner />
              <span className="muted small">
                {detail.debate.stage === 'round1' && 'Round 1 — independent answers…'}
                {detail.debate.stage === 'round2' && 'Round 2 — reading each other…'}
                {detail.debate.stage === 'scribe' && 'Scribe is summarising…'}
                {detail.debate.stage === 'pack' && 'Building the NotebookLM pack…'}
                {detail.debate.stage === 'done' && 'Finishing…'}
              </span>
            </div>
          )}

          {rounds.map(({ round, messages }) => (
            <section key={round} className="round">
              <div className="round-label">
                {round <= 2 ? `Round ${round}` : `Round ${round}`}
              </div>
              {messages.map((m) =>
                m.role === 'user' ? (
                  <div key={m.id} className="bubble user">
                    <div className="who">🙋 You</div>
                    <div className="body">{m.body}</div>
                  </div>
                ) : (
                  <PersonaBubble key={m.id} message={m} persona={byId.get(m.persona_id ?? '')} />
                ),
              )}
            </section>
          ))}

          {detail.scribe && <ScribePanel scribe={detail.scribe} byId={byId} onDig={dig} />}
        </>
      )}
    </div>
  );
}

function PersonaBubble({ message, persona }: { message: Message; persona?: Persona }) {
  return (
    <article className="bubble persona">
      <div className="who">
        <span className="avatar">{persona?.emoji ?? '🗣'}</span>
        <span className="name">{persona?.display_name ?? message.persona_id}</span>
        <span className="sim">simulated</span>
        <Chip answer={message.answer} />
      </div>
      <div className="body">{message.body}</div>
      {message.citations.length > 0 && (
        <ul className="cites">
          {message.citations.map((c) => (
            <li key={c.url}>
              <a href={c.url} target="_blank" rel="noreferrer noopener">
                {c.title || c.url}
              </a>
              {c.date ? <span className="muted tiny"> · {c.date}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {message.inference && (
        <div className="inference">
          🧪 Inference — no stored source on this specific point, reasoning from known views.
        </div>
      )}
    </article>
  );
}

function ScribePanel({
  scribe,
  byId,
  onDig,
}: {
  scribe: Scribe;
  byId: Map<string, Persona>;
  onDig: (tag: string) => void;
}) {
  const peerReview = scribe.peer_review ?? [];
  return (
    <section className="panel scribe">
      <div className="scribe-head">
        <h3>📋 Scribe</h3>
        {scribe.headline && <p className="muted small">{scribe.headline}</p>}
      </div>

      {scribe.synthesis && <p className="scribe-synthesis">{scribe.synthesis}</p>}

      {peerReview.length > 0 && (
        <div className="block">
          <h4>Blind peer review · arguments, not people</h4>
          <ol className="peer-ranks">
            {peerReview.map((r) => {
              const p = byId.get(r.personaId);
              return (
                <li key={r.personaId}>
                  <span>{p?.emoji} {p?.display_name ?? r.personaId}</span>
                  <span className="muted tiny">avg #{r.averageRank} · {r.judges} judges</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      <div className="verdicts">
        {scribe.verdicts.map((v) => {
          const p = byId.get(v.persona_id);
          return (
            <div key={v.persona_id} className="verdict">
              <div className="row between">
                <span className="name">
                  {p?.emoji} {p?.display_name ?? v.persona_id}
                </span>
                <Chip answer={v.answer} />
              </div>
              <p className="muted small">{v.top_reason}</p>
            </div>
          );
        })}
      </div>

      {scribe.agreements.length > 0 && (
        <div className="block">
          <h4>Where they agree</h4>
          <ul>
            {scribe.agreements.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {scribe.disagreements.length > 0 && (
        <div className="block">
          <h4>Where they disagree</h4>
          <ul>
            {scribe.disagreements.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      {scribe.next_steps.length > 0 && (
        <div className="block">
          <h4>Your next steps</h4>
          <ol>
            {scribe.next_steps.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ol>
        </div>
      )}
      {scribe.hashtags.length > 0 && (
        <div className="block">
          <h4>Follow up</h4>
          <div className="row wrap gap6">
            {scribe.hashtags.map((tag) => (
              <button key={tag} className="tag" onClick={() => onDig(tag)}>
                {tag}
              </button>
            ))}
          </div>
        </div>
      )}
      {(scribe.search_keywords.ar.length > 0 || scribe.search_keywords.en.length > 0) && (
        <div className="block">
          <h4>Search keywords</h4>
          <p className="muted small">
            {[...scribe.search_keywords.en, ...scribe.search_keywords.ar].join(' · ')}
          </p>
        </div>
      )}
      {scribe.disclaimer && <div className="disclaimer">⚠️ {scribe.disclaimer}</div>}
    </section>
  );
}
