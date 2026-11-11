export interface Persona {
  id: string;
  display_name: string;
  emoji: string;
  bio: string;
  speaking_style: string;
  core_values: string[];
  known_biases: string[];
  topics_of_expertise: string[];
  source_feeds: { type: string; url?: string; query?: string; route?: string; label?: string }[];
  model_override: string | null;
  enabled: boolean;
  origin: string;
  updated_at?: string;
  documents?: number;
  beliefs?: number;
}

export type Answer = 'yes' | 'no' | 'depends';

export interface Citation {
  title: string;
  date: string | null;
  url: string;
}

export interface Message {
  id: string;
  persona_id: string | null;
  round: number;
  role: 'persona' | 'scribe' | 'user' | 'system';
  answer: Answer | null;
  body: string;
  citations: Citation[];
  inference: boolean;
  created_at: string;
}

export interface Verdict {
  persona_id: string;
  answer: Answer;
  top_reason: string;
}

export interface PeerReviewSummary {
  personaId: string;
  averageRank: number;
  points: number;
  judges: number;
}

export interface Scribe {
  headline: string;
  synthesis: string;
  peer_review: PeerReviewSummary[];
  verdicts: Verdict[];
  agreements: string[];
  disagreements: string[];
  next_steps: string[];
  hashtags: string[];
  search_keywords: { ar: string[]; en: string[] };
  disclaimer: string | null;
}

export interface Debate {
  id: string;
  question: string;
  lang: string;
  mode: string;
  persona_ids: string[];
  status: string;
  stage: string;
  hashtags: string[];
  created_at: string;
  finished_at: string | null;
}

export interface Settings {
  recency_half_life_days: number;
  rounds: number;
  persona_word_limit: number;
  language: 'auto' | 'en' | 'ar';
  models_override: string | null;
  max_docs_per_scout_run: number;
  parallel_round1: boolean;
}

export interface Quota {
  remaining: number | null;
  limit: number | null;
  used: number | null;
  source: string;
  formatted: string;
}

export interface Draft {
  id: string;
  persona_id: string;
  yaml: string;
  payload: { name?: string; sources?: { title: string; url: string }[] };
  created_at: string;
}

export interface Bootstrap {
  ok: boolean;
  settings: Settings;
  models: string[];
  lastModel?: string | null;
  quota: Quota;
  queue: number;
  personas: Persona[];
  drafts: Draft[];
}

export interface BeliefRow {
  id: string;
  persona_id: string;
  topic: string;
  topic_key: string;
  stance: string;
  quote_or_paraphrase: string;
  is_quote: boolean;
  confidence: number;
  stated_on: string | null;
  source_url: string | null;
  source_title: string | null;
  created_at: string;
  superseded_at: string | null;
}

export interface BeliefTopic {
  topic_key: string;
  topic: string;
  current: BeliefRow | null;
  history: BeliefRow[];
}

export interface DocRow {
  id: string;
  persona_id: string;
  title: string;
  url: string;
  kind: string;
  lang: string;
  published_at: string | null;
  fetched_at: string;
  content_chars: number;
}

export interface FeedRow {
  id: string;
  persona_id: string;
  kind: string;
  label: string;
  url: string | null;
  query: string | null;
}

export interface HashtagRow {
  tag: string;
  uses: number;
  debate_id: string | null;
  last_used_at: string;
}
