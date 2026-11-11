import type { Answer, Citation, PeerReviewItem, Persona, Round1Item } from '../types';
import { asArray, extractJson, oneOf, str } from '../llm/json';
import { limitWords } from '../util/text';

export interface AggregateRank {
  personaId: string;
  averageRank: number;
  points: number;
  judges: number;
}

/** Stable for retries, rotated per debate so persona list order is not a permanent advantage. */
export function blindViewMap(personaIds: string[], debateId: string): Record<string, string> {
  const ids = [...new Set(personaIds)];
  if (!ids.length) return {};
  let hash = 2166136261;
  for (const ch of debateId) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
  const offset = hash % ids.length;
  const rotated = [...ids.slice(offset), ...ids.slice(0, offset)];
  return Object.fromEntries(rotated.map((id, i) => [`V-${String.fromCharCode(65 + i)}`, id]));
}

export function parsePeerReview(
  raw: string,
  personaId: string,
  candidateViewIds: string[],
  wordLimit: number,
  citationsByView: Record<string, Citation[]> = {},
): PeerReviewItem {
  const parsed = extractJson<Record<string, unknown>>(raw) ?? {};
  const allowed = new Set(candidateViewIds);
  const source = asArray<Record<string, unknown>>(parsed.ranking);
  const ranking: PeerReviewItem['ranking'] = [];
  const usedViews = new Set<string>();
  const usedRanks = new Set<number>();

  for (const item of source) {
    const viewId = str(item.view_id ?? item.viewId).toUpperCase();
    const rank = Number(item.rank);
    if (!allowed.has(viewId) || usedViews.has(viewId) || !Number.isInteger(rank) || rank < 1 || rank > candidateViewIds.length || usedRanks.has(rank)) {
      continue;
    }
    usedViews.add(viewId);
    usedRanks.add(rank);
    ranking.push({
      viewId,
      rank,
      rationale: limitWords(str(item.rationale), 30),
    });
  }

  ranking.sort((a, b) => a.rank - b.rank);
  const target = str(parsed.target_view_id ?? parsed.targetViewId).toUpperCase();
  const citedViews = asArray<unknown>(parsed.cited_views)
    .map((view) => str(view).toUpperCase())
    .filter((view) => allowed.has(view));
  const citations = [...new Map(citedViews.flatMap((view) => citationsByView[view] ?? []).map((citation) => [citation.url, citation])).values()];

  return {
    personaId,
    reply: limitWords(str(parsed.reply), wordLimit) || 'I do not have a substantive response.',
    reaction: oneOf(parsed.reaction, ['agree', 'push_back', 'change_mind'] as const, 'push_back'),
    answer: oneOf<Answer>(parsed.answer, ['yes', 'no', 'depends'], 'depends'),
    targetViewId: allowed.has(target) ? target : ranking[0]?.viewId,
    ranking,
    citations,
    inference: citations.length === 0,
  };
}

/** Parse one batch completion into one independently framed review per persona. */
export function parsePeerReviews(
  raw: string,
  personas: Persona[],
  viewMap: Record<string, string>,
  round1: Round1Item[],
  wordLimit: number,
): PeerReviewItem[] {
  const parsed = extractJson<unknown>(raw);
  const rows = asArray<Record<string, unknown>>(parsed);
  const byReviewer = new Map(rows.map((row) => [str(row.reviewer_id ?? row.persona_id), row]));

  return personas.map((persona) => {
    const candidates = Object.keys(viewMap);
    const citationsByView = Object.fromEntries(
      candidates.map((viewId) => [viewId, round1.find((answer) => answer.personaId === viewMap[viewId])?.citations ?? []]),
    );
    return parsePeerReview(
      JSON.stringify(byReviewer.get(persona.id) ?? {}),
      persona.id,
      candidates,
      wordLimit,
      citationsByView,
    );
  });
}

/** Average-rank aggregation; a reviewer never votes on their own response. */
export function aggregatePeerReviews(
  reviews: PeerReviewItem[],
  viewMap: Record<string, string>,
): AggregateRank[] {
  const totals = new Map<string, { rank: number; points: number; judges: number }>();

  for (const review of reviews) {
    const ownView = Object.entries(viewMap).find(([, personaId]) => personaId === review.personaId)?.[0];
    const peers = (review.ranking ?? [])
      .filter((r) => r.viewId !== ownView && viewMap[r.viewId])
      .sort((a, b) => a.rank - b.rank);
    const maxRank = peers.length;
    for (const [index, entry] of peers.entries()) {
      const personaId = viewMap[entry.viewId];
      const total = totals.get(personaId) ?? { rank: 0, points: 0, judges: 0 };
      const peerRank = index + 1;
      total.rank += peerRank;
      total.points += Math.max(0, maxRank + 1 - peerRank);
      total.judges++;
      totals.set(personaId, total);
    }
  }

  return [...totals.entries()]
    .map(([personaId, total]) => ({
      personaId,
      averageRank: Math.round((total.rank / total.judges) * 100) / 100,
      points: total.points,
      judges: total.judges,
    }))
    .sort((a, b) => a.averageRank - b.averageRank || b.points - a.points || a.personaId.localeCompare(b.personaId));
}
