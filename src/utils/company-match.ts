/**
 * Spoken-company matching for the ambiguous-multi-company lock branch.
 *
 * WHY THIS EXISTS
 * Before this, Twilio rendered the candidate company names and contact_ids into
 * caller_context and instructed Ivy to "silently match the caller's answer
 * against the candidates above -- do not name them aloud". She read them aloud
 * anyway. Measured 2026-07-27..30: 6 severe pre-lock disclosures in 80 calls
 * (7.5%), against 1 in 493 on the prior window, four of them on this branch --
 * e.g. "I see two companies on file for this number. Could you confirm which one
 * you're calling for: Innovative DisplayWorks Inc. or Consolidated Services".
 * That is one client's account structure read to a caller whose identity is not
 * confirmed. A fourth restatement of the rule was not going to fix it.
 *
 * So the matching moves server-side and the names stop being sent. She asks the
 * question, passes the caller's raw answer, and receives a verdict. She cannot
 * read out a list she was never given.
 *
 * Pure functions: no I/O, offline-benchable.
 */

export interface CompanyCandidate {
  contactId: number;
  companyId: number | null;
  companyName: string | null;
  classification: string | null;
  primaryContact?: boolean | null;
}

export type CompanyVerdict =
  | { status: 'locked'; candidate: CompanyCandidate; via: 'exact_token' | 'fuzzy_token' | 'residential' }
  | { status: 'ambiguous_company'; count: number }
  | { status: 'ambiguous_residential'; count: number }
  | { status: 'company_no_match' }
  // The company answer settled the ACCOUNT but not the PERSON: every top
  // scorer is the same company, carried by several contacts on this phone.
  | { status: 'company_only'; companyId: number; count: number }
  | { status: 'no_answer' };

const norm = (s: unknown): string =>
  String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const tokens = (s: unknown): string[] => norm(s).split(' ').filter(w => w.length > 2);

/**
 * Legal-form and filler tokens carry no discriminating power and actively cause
 * false matches: two candidates that are both "... Inc." would tie on "inc".
 */
const STOPWORDS = new Set([
  'inc', 'llc', 'cpa', 'corp', 'corporation', 'incorporated', 'the', 'and',
  'company', 'group', 'llp', 'pllc', 'ltd', 'limited', 'services', 'service',
  'solutions', 'associates', 'partners', 'holdings', 'enterprises',
]);

const distinctive = (s: unknown): string[] => tokens(s).filter(w => !STOPWORDS.has(w));

export function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, r) => {
    const row = new Array(b.length + 1).fill(0); row[0] = r; return row;
  });
  for (let c = 1; c <= b.length; c++) dp[0][c] = c;
  for (let r = 1; r <= a.length; r++)
    for (let c = 1; c <= b.length; c++)
      dp[r][c] = Math.min(dp[r - 1][c] + 1, dp[r][c - 1] + 1, dp[r - 1][c - 1] + (a[r - 1] === b[c - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

/** Same bounded threshold used for person names: 1 edit for short tokens, 2 for longer. */
const threshold = (s: string): number => (s.length <= 4 ? 1 : 2);

/** Caller signalling "this is not a business call". */
const RESIDENTIAL_INTENT =
  /\bnot a company\b|\bno company\b|\bresidential\b|\bpersonal\b|\bmy ?self\b|\bhome\b|\bhouse\b|\bprivate\b|\bindividual\b/;

/**
 * Match the caller's spoken answer to "What company are you calling for?"
 * against the companies their phone is on file at.
 *
 * Token-based on purpose, not whole-string edit distance: "Kawan Patel" (STT for
 * "Kho & Patel") is 8 edits from "kho patel cpa" as a string and would never
 * match, but shares the exact distinctive token "patel". Whole-string matching
 * fails every real case in the 2026-07 corpus; token matching passes all of them.
 *
 * Never returns a lock on a tie. An unverified caller who cannot name their own
 * company gets a retry, then the Identity SOP two-attempt cap.
 */
export function matchSpokenCompany(
  candidates: CompanyCandidate[],
  spoken?: string | null
): CompanyVerdict {
  const s = norm(spoken);
  if (!s) return { status: 'no_answer' };
  if (!candidates || candidates.length === 0) return { status: 'company_no_match' };

  // Residential intent is answered by classification, not by name matching:
  // a residential company is named after the person ("Garcia, Cindy"), so the
  // caller saying "not a company" carries no tokens to match on.
  if (RESIDENTIAL_INTENT.test(s)) {
    const res = candidates.filter(c => (c.classification ?? '').toLowerCase() === 'residential');
    if (res.length === 1) return { status: 'locked', candidate: res[0], via: 'residential' };
    if (res.length > 1) return { status: 'ambiguous_residential', count: res.length };
    return { status: 'company_no_match' };
  }

  const spokenToks = distinctive(spoken);
  if (spokenToks.length === 0) return { status: 'company_no_match' };

  const scored = candidates.map(c => {
    const candToks = distinctive(c.companyName);
    let exact = 0, fuzzy = 0;
    for (const a of spokenToks) {
      if (candToks.includes(a)) { exact++; continue; }
      if (candToks.some(b => editDistance(a, b) <= threshold(a))) fuzzy++;
    }
    // An exact token is worth more than a fuzzy one, so "Steele" beats a
    // coincidental near-miss elsewhere in the list.
    return { c, exact, fuzzy, score: exact * 2 + fuzzy };
  }).sort((x, y) => y.score - x.score);

  if (scored[0].score === 0) return { status: 'company_no_match' };

  const best = scored.filter(x => x.score === scored[0].score);

  // Scoring runs per CONTACT, so a company is scored once per person of theirs
  // on this phone. Seven colleagues at one account produced seven identical top
  // scores and the old tie check read that as ambiguity, refusing to lock -- so
  // the account became unreachable from that phone even when the caller said its
  // name exactly (Brian's test call, conv_5201..., 2026-08-30).
  //
  // The tie that matters is between COMPANIES. But resolving the company does
  // NOT resolve the person, and this verdict feeds a response carrying
  // first_name/last_name: picking a contact here would have answered Brian as
  // "Tom", the primary contact at his account. So one company with several
  // contacts settles the account and stops -- the caller is asked who they are.
  const bestCompanyIds = new Set(
    best.map(x => x.c.companyId).filter((id): id is number => id != null)
  );
  if (bestCompanyIds.size > 1) {
    return { status: 'ambiguous_company', count: bestCompanyIds.size };
  }
  if (best.length === 1) {
    return {
      status: 'locked',
      candidate: best[0].c,
      via: best[0].exact > 0 ? 'exact_token' : 'fuzzy_token',
    };
  }
  if (bestCompanyIds.size === 1) {
    return { status: 'company_only', companyId: [...bestCompanyIds][0], count: best.length };
  }
  // Several tied candidates carrying no company id at all: nothing to settle.
  return { status: 'ambiguous_company', count: best.length };
}
