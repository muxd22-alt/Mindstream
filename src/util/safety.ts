import type { Settings } from '../types';
import { detectLang } from './text';

const SENSITIVE = [
  // money
  'mortgage', 'loan', 'invest', 'investing', 'stock', 'stocks', 'crypto', 'bitcoin', 'buy', 'sell',
  'house', 'home', 'apartment', 'rent', 'salary', 'finance', 'financial', 'insurance', 'debt',
  'retirement', 'savings', 'zakat', 'tax', 'budget', 'down payment', 'interest rate',
  // health
  'health', 'medical', 'medicine', 'doctor', 'surgery', 'dose', 'therapy', 'depression', 'cancer', 'pregnant',
  // legal
  'legal', 'law', 'lawyer', 'court', 'contract', 'divorce', 'custody', 'visa', 'residency', 'inheritance', 'will',
  // Arabic
  'رهن', 'تمويل', 'عقاري', 'قرض', 'استثمار', 'أسهم', 'سهم', 'عملة', 'بيت', 'شقة', 'إيجار', 'راتب',
  'مالي', 'تأمين', 'دين', 'تقاعد', 'ادخار', 'زكاة', 'ضريبة', 'ميزانية', 'دفعة أولى', 'فائدة',
  'صحة', 'مرض', 'علاج', 'دواء', 'عملية', 'طبيب', 'اكتئاب', 'سرطان', 'حمل',
  'قانون', 'محكمة', 'عقد', 'طلاق', 'حضانة', 'تأشيرة', 'إقامة', 'ميراث', 'وصية',
];

const SAUDI = [
  'saudi', 'ksa', 'riyadh', 'jeddah', 'dammam', 'makkah', 'medina', 'sakani', 'sama', 'vision 2030',
  'السعودية', 'الرياض', 'جدة', 'الدمام', 'مكة', 'المدينة', 'سكني', 'ساما', 'رؤية 2030', 'ريال',
];

export function isSensitiveQuestion(question: string): boolean {
  const q = question.toLowerCase();
  return SENSITIVE.some((k) => q.includes(k));
}

export function isSaudiRelevant(question: string): boolean {
  const q = question.toLowerCase();
  return SAUDI.some((k) => q.includes(k)) || detectLang(question) === 'ar';
}

/** Which language to answer in. `auto` follows the question. */
export function responseLanguage(question: string, settings: Settings): 'ar' | 'en' {
  if (settings.language === 'ar' || settings.language === 'en') return settings.language;
  return detectLang(question);
}

export function safetyLine(question: string, lang: 'ar' | 'en'): string {
  const parts: string[] = [];
  if (isSensitiveQuestion(question)) {
    parts.push(
      lang === 'ar'
        ? 'هذا السؤال يتعلق بالمال أو الصحة أو القانون: قدّم رأيك بوضوح، لكن لا تقدّم أرقاماً أو نسباً أو أحكاماً مهنية غير موجودة في المصادر، واذكر أن هذه محاكاة وليست نصيحة مهنية.'
        : 'This question touches money, health or law: give your view clearly, but do not state rates, fees, dosages or professional rulings that are not in the sources, and note that this is a simulation, not professional advice.',
    );
  }
  if (isSaudiRelevant(question)) {
    parts.push(
      lang === 'ar'
        ? 'السياق سعودي: استخدم الريال السعودي (SAR)، ولوائح التمويل العقاري من البنك المركزي السعودي (ساما)، وبرنامج سكني، ورؤية 2030 — فقط عندما تدعمها المصادر. لا تخترع نسباً أو رسوماً حالية.'
        : 'Saudi context: use Saudi riyals (SAR), SAMA mortgage-financing rules, the Sakani programme and Vision 2030 — only where the sources support it. Never invent current rates or fees.',
    );
  }
  return parts.length ? `## Safety\n${parts.map((p) => `- ${p}`).join('\n')}` : '';
}

export function defaultFooter(lang: 'ar' | 'en'): string {
  return lang === 'ar'
    ? '⚠️ محاكاة لأغراض المعلومات فقط — ليست نصيحة مالية أو طبية أو قانونية.'
    : '⚠️ Simulated debate, for information only — not financial, medical or legal advice.';
}

export function saudiContextBlock(question: string, lang: 'ar' | 'en'): string {
  if (!isSaudiRelevant(question)) return '';
  return lang === 'ar'
    ? 'السياق: المستخدم في السعودية. عند الاقتضاء، تحدّث بالريال السعودي، ولوائح ساما للتمويل العقاري، وبرنامج سكني، وأهداف الإسكان في رؤية 2030 — دون اختلاق أرقام.'
    : 'Context: the user is in Saudi Arabia. Where relevant, reason in SAR, SAMA mortgage rules, the Sakani programme and Vision 2030 housing targets — without inventing numbers.';
}
