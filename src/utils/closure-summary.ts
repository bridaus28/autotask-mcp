// ─── Closure summary (2026-10-06) ──────────────────────────────────────────
//
// The closure report's Summary line used ElevenLabs' transcript_summary, whose
// wording we do not control. T20261006.0026: it said the caller "misidentified
// herself as Danny" when Ivy had misheard "Danny, please" as a name, and it
// carries the transcript's spelling of names. Our own data-collection field,
// call_summary, is written under our rules (attribute Ivy's mistakes to Ivy,
// spell names from the Autotask records). It wins when present; the vendor
// summary stays as the fallback so a report is never empty.

export function closureSummary(analysis: any): string {
  const ours = analysis?.data_collection_results?.call_summary?.value;
  if (typeof ours === 'string' && ours.trim() && ours.trim().toLowerCase() !== 'none') return ours.trim();
  return analysis?.transcript_summary || 'No summary available.';
}
