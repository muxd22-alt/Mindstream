import type { Answer } from '../types';

export function answerLabel(answer: Answer | null | undefined): string {
  if (!answer) return '';
  return answer === 'yes' ? 'YES' : answer === 'no' ? 'NO' : 'DEPENDS';
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return iso.slice(0, 10);
}

export function shortDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return iso.slice(0, 10);
}
