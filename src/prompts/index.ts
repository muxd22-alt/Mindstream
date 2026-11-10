import { PROMPTS } from '../generated/prompts';

export type PromptName = 'round1' | 'round2' | 'scribe' | 'beliefs' | 'chat' | 'persona_draft';

/** Replace {{var}} placeholders. Unknown placeholders are left visible on purpose. */
export function renderPrompt(name: PromptName | string, vars: Record<string, string | number | null | undefined>): string {
  const template = PROMPTS[name];
  if (!template) throw new Error(`Prompt "${name}" not found in /prompts`);
  return template.replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, key: string) => {
    const v = vars[key];
    if (v === undefined || v === null) return match;
    return String(v);
  });
}

export function splitSystemUser(rendered: string): { system: string; user: string } {
  const marker = '\n---\n';
  const idx = rendered.indexOf(marker);
  if (idx === -1) return { system: '', user: rendered };
  return {
    system: rendered.slice(0, idx).trim(),
    user: rendered.slice(idx + marker.length).trim(),
  };
}

export function hasPrompt(name: string): boolean {
  return typeof PROMPTS[name] === 'string';
}
