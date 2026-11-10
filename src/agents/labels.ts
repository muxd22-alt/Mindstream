import type { Answer } from '../types';

export function answerLabel(answer: Answer | null | undefined, lang: 'ar' | 'en'): string {
  if (!answer) return '—';
  const map: Record<Answer, { en: string; ar: string }> = {
    yes: { en: 'YES', ar: 'نعم' },
    no: { en: 'NO', ar: 'لا' },
    depends: { en: 'DEPENDS', ar: 'يعتمد' },
  };
  return map[answer]?.[lang] ?? String(answer).toUpperCase();
}

export function reactionLabel(reaction: string, lang: 'ar' | 'en'): string {
  const map: Record<string, { en: string; ar: string }> = {
    agree: { en: 'agrees', ar: 'يوافق' },
    push_back: { en: 'pushes back', ar: 'يعترض' },
    change_mind: { en: 'changes their mind', ar: 'يغيّر رأيه' },
  };
  return map[reaction]?.[lang] ?? reaction;
}
