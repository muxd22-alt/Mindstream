import { useState } from 'react';
import { api, haptic, tg } from '../api';
import type { Settings } from '../types';

interface Props {
  initial: Settings;
  models: string[];
  lastModel: string | null;
  onNotice: (s: string) => void;
}

export default function SettingsTab({ initial, models, lastModel, onNotice }: Props) {
  const [settings, setSettings] = useState<Settings>(initial);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.saveSettings(settings);
      haptic('success');
      onNotice('Settings saved.');
    } catch (e) {
      haptic('error');
      onNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function set<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((s) => ({ ...s, [key]: value }));
  }

  const user = tg()?.initDataUnsafe?.user;

  return (
    <div className="stack">
      <div className="panel">
        <h3>⚙️ Debate settings</h3>

        <label className="field">
          <span>Recency half-life (days)</span>
          <input
            type="number"
            min={1}
            max={3650}
            value={settings.recency_half_life_days}
            onChange={(e) => set('recency_half_life_days', Number(e.target.value))}
          />
          <span className="muted tiny">How fast old sources lose weight. 90 = a 3-month-old source counts half.</span>
        </label>

        <label className="field">
          <span>Rounds</span>
          <input
            type="number"
            min={1}
            max={4}
            value={settings.rounds}
            onChange={(e) => set('rounds', Number(e.target.value))}
          />
          <span className="muted tiny">1 skips the rebuttal round and saves a model request.</span>
        </label>

        <label className="field">
          <span>Words per persona</span>
          <input
            type="number"
            min={40}
            max={400}
            value={settings.persona_word_limit}
            onChange={(e) => set('persona_word_limit', Number(e.target.value))}
          />
          <span className="muted tiny">Hard-capped server side, not just in the prompt.</span>
        </label>

        <label className="field">
          <span>Live mode</span>
          <select
            value={settings.parallel_round1 ? 'on' : 'off'}
            onChange={(e) => set('parallel_round1', e.target.value === 'on')}
          >
            <option value="on">On — one call per persona, answers land one by one</option>
            <option value="off">Off — one call for all three (cheaper)</option>
          </select>
          <span className="muted tiny">Live mode uses 3 requests for Round 1 instead of 1.</span>
        </label>

        <label className="field">
          <span>Language</span>
          <select value={settings.language} onChange={(e) => set('language', e.target.value as Settings['language'])}>
            <option value="auto">Auto (match my message)</option>
            <option value="en">English</option>
            <option value="ar">العربية</option>
          </select>
        </label>

        <label className="field">
          <span>Models override (optional)</span>
          <textarea
            rows={3}
            value={settings.models_override ?? ''}
            onChange={(e) => set('models_override', e.target.value || null)}
            placeholder="comma separated, ordered fallback"
          />
          <span className="muted tiny">
            Leave empty to use the MODELS variable. Paid models are ignored unless the operator explicitly enables
            them.
          </span>
        </label>

        <button onClick={() => void save()} disabled={saving}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
      </div>

      <div className="panel">
        <h3>🧩 Model chain</h3>
        <p className="muted small">
          In use now: <code>{lastModel ?? models[0] ?? 'not run yet'}</code>
        </p>
        <ol className="model-chain">
          {(settings.models_override ? settings.models_override.split(',').map((s) => s.trim()).filter(Boolean) : models).map(
            (m, i) => (
              <li key={m}>
                <span className="muted tiny">{i + 1}</span> <code>{m}</code>
              </li>
            ),
          )}
        </ol>
        <p className="muted tiny mt8">
          On 429 or any error, the next model answers. /status in Telegram shows which one is in use and how many free
          requests are left today.
        </p>
      </div>

      <div className="panel">
        <h3>🪪 Account</h3>
        <p className="muted small">
          Signed in as {user ? `${user.first_name ?? 'you'} (${user.id})` : 'the configured owner'}.
          <br />
          The bot and this Mini App ignore every other Telegram account.
        </p>
      </div>

      <div className="panel">
        <h3>📓 NotebookLM</h3>
        <p className="muted small">
          Every debate produces a Markdown pack plus <code>sources.txt</code>, sent to you on Telegram by{' '}
          <code>/notebook</code>. If a Drive folder is configured, a Google Doc is uploaded so you can add it as a
          NotebookLM source in one tap.
        </p>
      </div>
    </div>
  );
}
