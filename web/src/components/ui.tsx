import type { ReactNode } from 'react';
import type { Answer } from '../types';
import { answerLabel } from './labels';

export function Chip({ answer }: { answer: Answer | null }) {
  if (!answer) return null;
  return <span className={`chip ${answer}`}>{answerLabel(answer)}</span>;
}

export function Badge({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'warn' | 'ok' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Spinner() {
  return <div className="spinner" />;
}

export function ErrorBox({ message }: { message: string }) {
  return <div className="panel error-panel small">{message}</div>;
}
