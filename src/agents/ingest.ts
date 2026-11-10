import type { Ctx, FetchedDoc } from '../types';
import { existingHashes, getPersona, insertChunks, insertDocuments } from '../db/repo';
import { nowIso } from '../db/client';
import { chunkText } from '../ai/chunk';
import { embedTexts, encodeVector } from '../ai/embed';
import { normalizeUrl, sha256Hex } from '../util/hash';
import { detectLang, truncate, uniqueBy } from '../util/text';

interface ChunkRow {
  document_id: string;
  persona_id: string;
  chunk_index: number;
  content: string;
  tokens: number;
  embedding: string;
}

/**
 * Used by the `yt-transcripts` GitHub Action and any external ingester.
 * If a document already exists and the new text is longer (e.g. a transcript
 * arrives after the video description), the document is replaced and re-chunked.
 */
export async function ingestExternalDocs(
  ctx: Ctx,
  personaId: string,
  docs: FetchedDoc[],
  sourceLabel = 'external',
): Promise<{ newDocs: number; updated: number; chunks: number }> {
  const persona = await getPersona(ctx, personaId);
  if (!persona) throw new Error(`Unknown persona ${personaId}`);

  const normalized = uniqueBy(
    docs.filter((d) => d.url && d.content && d.content.length > 80).map((d) => ({ ...d, url: normalizeUrl(d.url) })),
    (d) => d.url,
  );
  const withHash = await Promise.all(normalized.map(async (doc) => ({ doc, hash: await sha256Hex(doc.url) })));
  const seen = await existingHashes(ctx, personaId, withHash.map((x) => x.hash));

  const rows: ChunkRow[] = [];
  let newDocs = 0;
  let updated = 0;

  const fresh: { doc: FetchedDoc; hash: string }[] = [];
  for (const item of withHash) {
    if (!seen.has(item.hash)) {
      fresh.push(item);
      continue;
    }
    const existing = await ctx.db.first<{ id: string; content_chars: number }>(
      'select id, content_chars from documents where persona_id = ? and url_hash = ?',
      personaId,
      item.hash,
    );
    if (!existing) continue;
    if (item.doc.content.length <= existing.content_chars + 200) continue;
    // Transcript arrived for a document we already had: replace and re-chunk.
    await ctx.db.run(
      'update documents set content = ?, content_chars = ?, lang = ?, fetched_at = ? where id = ?',
      truncate(item.doc.content, 120_000, ''),
      item.doc.content.length,
      item.doc.lang ?? detectLang(item.doc.content),
      nowIso(),
      existing.id,
    );
    await ctx.db.run('delete from chunks where document_id = ?', existing.id);
    updated++;
    rows.push(...chunksFor(existing.id, personaId, item.doc.content, ctx.settings.max_chunks_per_doc));
  }

  const capped = fresh.slice(0, 20);
  if (capped.length) {
    const inserted = await insertDocuments(
      ctx,
      capped.map(({ doc, hash }) => ({
        persona_id: personaId,
        source_id: null,
        url: doc.url,
        url_hash: hash,
        title: truncate(doc.title || 'Untitled', 300),
        kind: doc.kind,
        lang: doc.lang ?? detectLang(doc.content),
        published_at: doc.publishedAt,
        content: truncate(doc.content, 120_000, ''),
        content_chars: doc.content.length,
        meta: { ...(doc.meta ?? {}), ingest: sourceLabel },
      })),
    );
    newDocs = inserted.length;
    const idByHash = new Map(inserted.map((r) => [r.url_hash, r.id]));
    for (const { doc, hash } of capped) {
      const id = idByHash.get(hash);
      if (!id) continue;
      rows.push(...chunksFor(id, personaId, doc.content, ctx.settings.max_chunks_per_doc));
    }
  }

  if (rows.length) {
    const vectors = await embedTexts(ctx, rows.map((r) => r.content));
    rows.forEach((r, i) => {
      r.embedding = encodeVector(vectors[i] ?? []);
    });
    await insertChunks(ctx, rows);
  }

  return { newDocs, updated, chunks: rows.length };
}

function chunksFor(documentId: string, personaId: string, content: string, max: number): ChunkRow[] {
  return chunkText(content)
    .slice(0, max)
    .map((c, idx) => ({
      document_id: documentId,
      persona_id: personaId,
      chunk_index: idx,
      content: c.content,
      tokens: c.tokens,
      embedding: '',
    }));
}
