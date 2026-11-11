// Shared types for Council.

export interface Env {
  // Secrets
  TELEGRAM_BOT_TOKEN: string;
  OPENROUTER_API_KEY: string;
  CF_ACCOUNT_ID: string;
  CF_API_TOKEN: string;
  ALLOWED_TELEGRAM_USER_ID: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;

  // Vars
  MODELS?: string;
  EMBED_MODEL?: string;
  RECENCY_HALF_LIFE_DAYS?: string;
  PERSONA_WORD_LIMIT?: string;
  MAX_DOCS_PER_SCOUT_RUN?: string;
  SCOUT_MAX_CHUNKS_PER_DOC?: string;
  ALLOW_PAID_MODELS?: string;

  // Optional
  INTERNAL_TOKEN?: string;
  PUBLIC_BASE_URL?: string;
  MINIAPP_ORIGIN?: string;
  RSSHUB_URL?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  MINIAPP_DEV_BYPASS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  GOOGLE_DRIVE_FOLDER_ID?: string;

  // Bindings
  AI?: Ai;
  DB: D1Database;
  ASSETS?: Fetcher;
  [key: string]: unknown;
}

export type FeedKind = 'googlenews' | 'rss' | 'blog' | 'youtube' | 'podcast' | 'rsshub';

export interface FeedSpec {
  type: FeedKind;
  url?: string;
  query?: string;
  route?: string;
  handle?: string;
  channel_id?: string;
  label?: string;
  enabled?: boolean;
}

export interface Persona {
  id: string;
  display_name: string;
  emoji: string;
  bio: string;
  speaking_style: string;
  core_values: string[];
  known_biases: string[];
  topics_of_expertise: string[];
  source_feeds: FeedSpec[];
  model_override?: string | null;
  enabled: boolean;
}

export interface PersonaRow extends Persona {
  yaml: string;
  origin: string;
  created_at?: string;
  updated_at?: string;
}

export interface Settings {
  recency_half_life_days: number;
  rounds: number;
  persona_word_limit: number;
  language: 'auto' | 'en' | 'ar';
  models_override: string | null;
  max_docs_per_scout_run: number;
  max_chunks_per_doc: number;
  /** One LLM call per persona, in parallel, so answers land one by one. */
  parallel_round1: boolean;
}

export interface Ctx {
  env: Env;
  db: import('./db/client').Db;
  settings: Settings;
  models: string[];
  now: Date;
}

export type Answer = 'yes' | 'no' | 'depends';

export interface Citation {
  title: string;
  date: string | null;
  url: string;
  ref?: string;
  snippet?: string;
}

export interface Round1Item {
  personaId: string;
  answer: Answer;
  reasoning: string;
  citations: Citation[];
  inference: boolean;
  inferenceNote?: string;
}

export interface Round2Item {
  personaId: string;
  reply: string;
  reaction: 'agree' | 'push_back' | 'change_mind';
  answer: Answer;
  targetViewId?: string;
  ranking?: PeerRanking[];
  citations?: Citation[];
  inference?: boolean;
}

export interface PeerRanking {
  viewId: string;
  rank: number;
  rationale: string;
}

export interface PeerReviewItem extends Round2Item {
  ranking: PeerRanking[];
  citations: Citation[];
  inference: boolean;
}

export interface PeerReviewSummary {
  personaId: string;
  averageRank: number;
  points: number;
  judges: number;
}

export interface ScribeResult {
  headline: string;
  synthesis: string;
  peer_review: PeerReviewSummary[];
  verdicts: { persona_id: string; answer: Answer; top_reason: string }[];
  agreements: string[];
  disagreements: string[];
  next_steps: string[];
  hashtags: string[];
  search_keywords: { ar: string[]; en: string[] };
  disclaimer: string | null;
}

export interface DebateRow {
  id: string;
  chat_id: number | null;
  user_id: number | null;
  question: string;
  lang: 'en' | 'ar';
  mode: 'council' | 'chat' | 'dig' | 'chat_thread';
  persona_ids: string[];
  thread_key: string | null;
  status: 'open' | 'running' | 'done' | 'error';
  stage: string;
  state: DebateState;
  scribe: ScribeResult | null;
  hashtags: string[];
  model: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface DebateState {
  round1?: Round1Item[];
  round2?: PeerReviewItem[];
  extra?: { round: number; items: Round2Item[] }[];
  /** persona_id → rendered prompt block (brief + sources), reused across rounds */
  blocks?: Record<string, string>;
  /** Anonymous view alias → author id, revealed only to the Scribe after reviews. */
  viewMap?: Record<string, string>;
  peerReviewAggregate?: PeerReviewSummary[];
  round2SentPersonaIds?: string[];
  peerReviews?: {
    round: number;
    viewMap: Record<string, string>;
    items: PeerReviewItem[];
    aggregate: PeerReviewSummary[];
  }[];
  scribe?: ScribeResult;
  sent?: { round1?: boolean; round2?: boolean; scribe?: boolean; pack?: boolean };
  error?: string;
  quotaNote?: string;
}

export interface MessageRow {
  id: string;
  debate_id: string;
  persona_id: string | null;
  round: number;
  role: 'persona' | 'scribe' | 'user' | 'system';
  answer: Answer | null;
  body: string;
  citations: Citation[];
  inference: boolean;
  model: string | null;
  created_at: string;
}

export interface RetrievedChunk {
  chunk_id: string;
  document_id: string;
  content: string;
  title: string;
  url: string;
  published_at: string | null;
  similarity: number;
  score: number;
}

export interface RetrievedBelief {
  belief_id: string;
  topic: string;
  stance: string;
  quote_or_paraphrase: string;
  is_quote: boolean;
  confidence: number;
  stated_on: string | null;
  source_url: string | null;
  source_title: string | null;
  similarity: number;
  score: number;
}

export interface FetchedDoc {
  url: string;
  title: string;
  content: string;
  publishedAt: string | null;
  kind: FeedKind;
  lang?: string;
  meta?: Record<string, unknown>;
  feedLabel?: string;
}

export interface JobRow {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'done' | 'error';
  payload: Record<string, unknown>;
  state: Record<string, unknown>;
  attempts: number;
  lease_until: string | null;
  model: string | null;
  error: string | null;
  result: Record<string, unknown> | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}
