import { SEED_KNOWLEDGE } from '../generated/knowledge';
import type { BeliefInput, NewDocument, NewChunk } from '../db/repo';
import {
  allBeliefs,
  existingHashes,
  getDocumentByHash,
  getPersona,
  getChunksForDocument,
  insertBelief,
  insertChunks,
  insertDocuments,
  liveBeliefs,
} from '../db/repo';
import type { Ctx } from '../types';
import { chunkText } from '../ai/chunk';
import { embedTexts, encodeVector } from '../ai/embed';
import { normalizeUrl, sha256Hex } from '../util/hash';
import { detectLang, stanceChanged, topicKey, truncate } from '../util/text';

interface SeedBelief {
  topic: string;
  source_url: string;
  stance: string;
  quote_or_paraphrase: string;
  is_quote: boolean;
  confidence: number;
  stated_on: string;
}

interface SeedDocument {
  url: string;
  title: string;
  kind?: string;
  lang?: string;
  published_at: string;
  content: string;
  beliefs: SeedBelief[];
}

interface SeedPersonaKnowledge {
  persona_id: string;
  documents: SeedDocument[];
}

export interface SeedKnowledgeResult {
  documents: number;
  chunks: number;
  beliefs: number;
  skipped: number;
  errors: string[];
}

/** Populate the initial, cited evidence pack from /knowledge/seeds/*.json. */
export async function syncSeedKnowledge(ctx: Ctx): Promise<SeedKnowledgeResult> {
  const result: SeedKnowledgeResult = { documents: 0, chunks: 0, beliefs: 0, skipped: 0, errors: [] };

  for (const [fileId, raw] of Object.entries(SEED_KNOWLEDGE)) {
    try {
      const seed = JSON.parse(raw) as SeedPersonaKnowledge;
      const personaId = String(seed.persona_id || fileId);
      if (!await getPersona(ctx, personaId)) {
        result.errors.push(`${fileId}: persona row is missing; seed personas before knowledge.`);
        continue;
      }

      for (const item of seed.documents ?? []) {
        if (!item.url || !item.title || !item.content || !item.published_at) {
          result.errors.push(`${fileId}: skipped incomplete seed document.`);
          result.skipped++;
          continue;
        }

        const url = normalizeUrl(item.url);
        const urlHash = await sha256Hex(url);
        const priorHashes = await existingHashes(ctx, personaId, [urlHash]);
        let document = await getDocumentByHash(ctx, personaId, urlHash);
        if (!priorHashes.has(urlHash)) {
          const rows: NewDocument[] = [{
            persona_id: personaId,
            source_id: null,
            url,
            url_hash: urlHash,
            title: truncate(item.title, 300),
            kind: item.kind ?? 'seed',
            lang: item.lang ?? detectLang(item.content),
            published_at: item.published_at,
            content: truncate(item.content, 20_000, ''),
            content_chars: item.content.length,
            meta: { seeded: true, source_file: fileId },
          }];
          const inserted = await insertDocuments(ctx, rows);
          document = inserted[0] ? { id: inserted[0].id } : await getDocumentByHash(ctx, personaId, urlHash);
          if (inserted[0]) result.documents++;
        }

        if (!document) {
          result.errors.push(`${fileId}: could not locate stored document ${url}.`);
          continue;
        }

        const existingChunks = await getChunksForDocument(ctx, document.id);
        if (!existingChunks.length) {
          const contentChunks = chunkText(item.content).slice(0, ctx.settings.max_chunks_per_doc);
          const vectors = await embedTexts(ctx, contentChunks.map((chunk) => chunk.content));
          const rows: NewChunk[] = contentChunks.map((chunk, index) => ({
            document_id: document!.id,
            persona_id: personaId,
            chunk_index: index,
            content: chunk.content,
            tokens: chunk.tokens,
            embedding: encodeVector(vectors[index] ?? []),
          }));
          await insertChunks(ctx, rows);
          result.chunks += rows.length;
        }

        for (const belief of item.beliefs ?? []) {
          const topic = String(belief.topic ?? '').trim();
          const stance = String(belief.stance ?? '').trim();
          if (!topic || !stance || normalizeUrl(belief.source_url) !== url) {
            result.errors.push(`${fileId}: skipped belief without a matching source URL.`);
            result.skipped++;
            continue;
          }
          const key = topicKey(topic);
          const history = await allBeliefs(ctx, personaId, { topic: key, limit: 100 });
          if (history.some((old) => old.source_url === url && old.stance === stance)) {
            result.skipped++;
            continue;
          }

          const current = (await liveBeliefs(ctx, personaId, key))[0];
          if (current) {
            if (current.stance === stance) {
              result.skipped++;
              continue;
            }
            if (current.stated_on && belief.stated_on && current.stated_on > belief.stated_on) {
              result.skipped++;
              continue;
            }
            if (!stanceChanged(current.stance, stance)) {
              result.skipped++;
              continue;
            }
          }

          const input: BeliefInput = {
            persona_id: personaId,
            topic,
            topic_key: key,
            stance,
            quote_or_paraphrase: String(belief.quote_or_paraphrase ?? ''),
            is_quote: belief.is_quote === true,
            confidence: Math.max(0, Math.min(1, Number(belief.confidence) || 0.5)),
            stated_on: belief.stated_on || item.published_at.slice(0, 10),
            source_id: document.id,
            source_url: url,
            source_title: item.title,
          };
          const vector = await embedTexts(ctx, [`${topic}: ${stance} ${input.quote_or_paraphrase}`]);
          await insertBelief(ctx, input, encodeVector(vector[0] ?? []));
          result.beliefs++;
        }
      }
    } catch (e) {
      result.errors.push(`${fileId}: ${e instanceof Error ? e.message.slice(0, 240) : String(e).slice(0, 240)}`);
    }
  }

  return result;
}
