/**
 * Spoken-name matching for the contact lock step (Phase A, 2026-06-11).
 * Same tiered approach proven on the tech roster since 7cd6222:
 * exact first, then bounded edit-distance, unique-best or no verdict.
 * Pure functions: offline-benchable, no I/O.
 */

export interface PoolContact {
  id: number;
  firstName?: string | null;
  lastName?: string | null;
  /**
   * Nickname / goes-by. CV convention 2026-07-29: stored in Autotask's
   * middleInitial, which is unused here and is string(50) despite its name.
   * Matched as an alternative FIRST name, never as a surname.
   *
   * Why this field is needed at all: nicknames are not spelling variants and
   * edit distance cannot reach them -- alex->alejandro is 6 edits against a
   * threshold of 1, sandy->cassandra is 5 against 2. Two duplicate contacts
   * were created this way (Sandy/Unknown at Cal Blend Soils 2026-06-30,
   * Alex Menz at Covina Arthritis 2026-07-29). No threshold tuning fixes it;
   * the record has to carry the name the caller actually uses.
   */
  middleInitial?: string | null;
  companyID?: number | null;
  primaryContact?: boolean | null;
}

export type MatchVerdict =
  | { status: 'locked'; contact: PoolContact; match: 'exact' | 'fuzzy' }
  // sole/soleBasis (S5, 2026-08-15): when exactly one candidate exists, carry it
  // and how it matched so the CALLER of this function can decide whether policy
  // allows locking it (phone-verified company). Never serialized to the agent.
  | { status: 'candidates'; count: number; sole?: PoolContact; soleBasis?: 'exact_first' | 'fuzzy' }
  | { status: 'new_contact' };

const norm = (s: unknown): string =>
  String(s ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();

const tokens = (s: unknown): string[] => norm(s).split(' ').filter(Boolean);

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

const threshold = (s: string): number => (s.length <= 4 ? 1 : 2);

/** Distance from one spoken name to the nearest token of a record field set. */
function nameDistance(spoken: string, recordTokens: string[]): number {
  if (recordTokens.length === 0) return Infinity;
  return Math.min(...recordTokens.map(t => editDistance(spoken, t)));
}

/**
 * Match a spoken first/last name against a pool of contacts.
 * Every provided name must land within its edit threshold on some token of
 * the candidate's name fields. Unique best total distance wins; exact-on-all
 * is reported as exact. Ties or nothing in range -> no individual verdict.
 */
export function matchSpokenName(
  pool: PoolContact[],
  spokenFirst?: string | null,
  spokenLast?: string | null
): MatchVerdict {
  const first = norm(spokenFirst);
  const last = norm(spokenLast);
  if (!first && !last) return pool.length ? { status: 'candidates', count: pool.length } : { status: 'new_contact' };

  const score = (spoken: string, c: PoolContact, fields: 'last' | 'all') => {
    const lastToks = tokens(c.lastName);
    // The nickname joins the first-name tokens, not the surname tokens: a
    // goes-by name is an alternative to the given name. Keeping it out of
    // lastToks matters because the last name is the primary key -- a nickname
    // must never be able to satisfy a surname match.
    const allToks = [...tokens(c.firstName), ...tokens(c.middleInitial), ...lastToks];
    return nameDistance(spoken, fields === 'last' ? (lastToks.length ? lastToks : allToks) : allToks);
  };

  // Last name is the primary key: STT and records disagree on first names
  // constantly (Nimfa/Nympha, nicknames), so a failed first name never
  // vetoes a solid last-name match. It only discriminates between several.
  if (last) {
    const lastMatches = pool
      .map(c => ({ c, d: score(last, c, 'last') }))
      .filter(x => x.d <= threshold(last))
      .sort((a, b) => a.d - b.d);
    if (lastMatches.length === 0) {
      // A surname that matches nothing is evidence that this channel failed, not
      // evidence the person is new. It fails two ways and both used to assert
      // new_contact on one bad token while the first name was never consulted:
      //
      //   mangled by STT   "Tom Daus" heard as "Tom Dev" -- 3 edits on a 3-char
      //                    token, unrecoverable by threshold.
      //                    (conv_5801kymnf5rsemprgwbn43vxpacp, 2026-07-28: a
      //                    contact on file since March told he was not listed.)
      //   not a surname    "Kristin at CalBlind Soils" -- the model puts the
      //                    company phrase in the surname slot. 10 of 385 lock
      //                    calls to 2026-07-31 do this; 4 returned new_contact.
      //                    (conv_...2mw8x1qb0sp9, 2026-07-31: duplicated Kristen
      //                    Dabela as "Kristin Dabela" at Cal Blend Soils.)
      //
      // Both are the same fact -- this token is not usable -- so drop it and reuse
      // the first-name-only path below rather than keeping a second, weaker copy
      // of that logic here. No parsing of company phrases is needed: a phrase that
      // is not a surname simply matches no surname, which lands right here.
      if (!first) return { status: 'new_contact' };
      const viaFirst = matchSpokenName(pool, first, null);
      // Never lock, even on a unique exact first name. The caller DID give a
      // surname and it did not match, which is equally consistent with someone
      // genuinely new who shares a first name with a contact on file. 'candidates'
      // makes her confirm ("I have a Tom on file -- is your last name Daus?");
      // 'locked' would make her assert. Precedent for not locking on a first name
      // against contrary evidence: Tanya -> Tony Whetstone, 2026-06-15.
      // Surname missed but a unique EXACT first name exists. Do not lock here
      // (the surname contradicts), but expose the sole candidate so the server
      // can lock it under S5 at a phone-verified company: "Martha Garcia" whose
      // surname token the file cannot match is the one Martha on file, and the
      // wrong answer there is the wrong colleague at the right company, not a
      // stranger. Fuzzy first names stay unliftable (Tanya -> Tony, 2026-06-15).
      if (viaFirst.status === 'locked') {
        return { status: 'candidates', count: 1, sole: viaFirst.contact, soleBasis: 'exact_first' };
      }
      return viaFirst;
    }
    const best = lastMatches.filter(x => x.d === lastMatches[0].d);
    if (best.length === 1) {
      const c = best[0].c;
      const exact = best[0].d === 0 && (!first || score(first, c, 'all') === 0);
      return { status: 'locked', contact: c, match: exact ? 'exact' : 'fuzzy' };
    }
    if (first) {
      const byFirst = best
        .map(x => ({ ...x, fd: score(first, x.c, 'all') }))
        .filter(x => x.fd <= threshold(first))
        .sort((a, b) => a.fd - b.fd);
      const bestFirst = byFirst.filter(x => x.fd === (byFirst[0]?.fd ?? Infinity));
      if (bestFirst.length === 1) {
        const x = bestFirst[0];
        return { status: 'locked', contact: x.c, match: x.d === 0 && x.fd === 0 ? 'exact' : 'fuzzy' };
      }
    }
    return { status: 'candidates', count: best.length };
  }

  // First-name-only: a first name alone is too weak to fuzzy-lock. Short
  // names collide (Tanya/Tony, Jon/Jan) and there is no last name to anchor,
  // so a fuzzy match here would write confirmed_* against the wrong contact
  // (Tanya->Tony Whetstone, 2026-06-15). Lock only on a unique EXACT first
  // name; an in-threshold fuzzy match returns candidates so the agent gathers
  // a last name before committing identity.
  const firstMatches = pool
    .map(c => ({ c, d: score(first, c, 'all') }))
    .filter(x => x.d <= threshold(first))
    .sort((a, b) => a.d - b.d);
  if (firstMatches.length === 0) return { status: 'new_contact' };
  const exact = firstMatches.filter(x => x.d === 0);
  if (exact.length === 1) {
    return { status: 'locked', contact: exact[0].c, match: 'exact' };
  }
  if (exact.length === 0 && firstMatches.length === 1) {
    // A single in-threshold FUZZY first name. Tagged so no caller of this
    // function can ever lock it: short first names collide (Tanya -> Tony).
    return { status: 'candidates', count: 1, sole: firstMatches[0].c, soleBasis: 'fuzzy' };
  }
  return { status: 'candidates', count: exact.length > 1 ? exact.length : firstMatches.length };
}

// ─── Placeholder-name detection (moved from mcp/server.ts 2026-08-15 so the ───
// ─── create-side guards can share it without an import cycle) ────────────────
// The model fills a parameter it thinks it needs rather than asking. The server
// cannot see the transcript, so it cannot tell in general whether a name was
// really spoken -- but a canonical placeholder is never a caller.
//
// DELIBERATELY NOT A LIST OF REAL NAMES. "Bruce Rideout" is a real customer and
// is not here; blocking it would refuse the actual person. Only names that no
// caller gives, and only as a complete first+last pair for the Smith/Doe forms,
// because Smith on its own is one of the commonest surnames we hold.
export const NON_NAME_TOKENS = new Set<string>([
  'unknown', 'unkown', 'none', 'null', 'na', 'n/a', 'test', 'testing',
  'caller', 'customer', 'client', 'user', 'anonymous', 'guest', 'someone',
  'firstname', 'lastname', 'first', 'last', 'sir', 'madam', 'nobody',
]);

export const PLACEHOLDER_PAIRS = new Set<string>([
  'john smith', 'jane smith', 'john doe', 'jane doe', 'joe bloggs',
  'john q public', 'mary major', 'richard roe',
]);

/** True when the "spoken" name is a placeholder rather than something a caller said. */
export function isPlaceholderSpokenName(first?: string | null, last?: string | null): boolean {
  const f = String(first ?? '').toLowerCase().replace(/[^a-z ]+/g, '').trim();
  const l = String(last ?? '').toLowerCase().replace(/[^a-z ]+/g, '').trim();
  if (f && NON_NAME_TOKENS.has(f)) return true;
  if (l && NON_NAME_TOKENS.has(l)) return true;
  const pair = `${f} ${l}`.trim();
  return pair.length > 0 && PLACEHOLDER_PAIRS.has(pair);
}

// ─── Company-name-as-surname detection (S2, 2026-08-15) ─────────────────────
// "Alma South Hills Escrow" came one parameter from becoming a contact on
// 2026-08-10: the caller's company went into lastName and only the phone gate
// stopped the write. A surname is refused when it matches the target company's
// name, or when it ends in a corporate designator no person's surname carries.
//
// Kept deliberately narrow: "De La Cruz" and other real multi-word surnames
// must pass. Token containment fires only when EVERY surname token appears in
// the company name (>=2 tokens), which a coincidental shared surname cannot do.
const CORPORATE_DESIGNATORS = new Set<string>([
  'inc', 'incorporated', 'llc', 'llp', 'corp', 'corporation', 'ltd', 'company', 'co',
]);

export function isCompanyNameAsSurname(lastName?: string | null, companyName?: string | null): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const l = norm(String(lastName ?? ''));
  if (!l) return false;
  const lTokens = l.split(' ');
  if (CORPORATE_DESIGNATORS.has(lTokens[lTokens.length - 1])) return true;
  const c = norm(String(companyName ?? ''));
  if (!c) return false;
  if (l === c) return true;
  if (lTokens.length >= 2) {
    const cTokens = new Set(c.split(' '));
    if (lTokens.every(t => cTokens.has(t))) return true;
  }
  return false;
}

// ─── B12: organization-shaped surnames at LOCK time (2026-08-16) ─────────────
// Corpus analysis (STT_NAME_ANALYSIS, 2,525 calls): ~15 identity failures began
// with the caller's COMPANY landing in spoken_last -- "Elsa Big Bear Municipal
// Water District", "Jessica BB Tax and Accounting", "Taylor SFG Management".
// The matcher then compared an organization name against surnames and failed.
// S2 blocks this shape at create time; this catches it where it starts, so the
// first name alone can still lock (S5) and the caller never notices.
//
// Kept deliberately narrow, same doctrine as isCompanyNameAsSurname: real
// compound surnames must pass. "De La Cruz" (3 tokens), "Parrilla Marquez",
// "De Sigio III" all pass. Fires on: a corporate designator anywhere, 4+
// tokens, or a token that is essentially never a surname (management,
// accounting, municipal...). Single-token surnames never fire except pure
// designators, so Church, Wells, and Marine the person stay reachable.
const ORG_ONLY_TOKENS = new Set<string>([
  'and', 'management', 'accounting', 'consulting', 'solutions', 'associates',
  'enterprises', 'industries', 'municipal', 'district', 'escrow', 'insurance',
  'realty', 'properties', 'staffing', 'logistics', 'systems', 'technologies',
  'services', 'group',
]);

export function isOrgShapedSurname(lastName?: string | null, companyName?: string | null): boolean {
  if (isCompanyNameAsSurname(lastName, companyName)) return true;
  const norm = String(lastName ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!norm) return false;
  const tokens = norm.split(' ');
  if (tokens.length >= 4) return true;
  if (tokens.length >= 2 && tokens.some(t => ORG_ONLY_TOKENS.has(t))) return true;
  return false;
}

export const ORG_SURNAME_GUIDANCE =
  'The last name received is shaped like an organization name rather than a ' +
  'family name, so the match ran on the first name alone. Keep the ' +
  'organization as company context if useful, ask for the caller\'s own last ' +
  'name, then lock again with it.';

// ─── S5: sole-candidate lock at a verified company (2026-08-15) ──────────────
// Policy, not matching: the matcher reports; this decides. At a company the
// PHONE already vouched for (prelock, phone-resolved, or caller-confirmed
// search result), exactly one candidate whose FIRST name matched exactly IS
// the caller -- the wrong answer picks the wrong colleague at the right
// company, never a stranger. Measured 2026-08-11..14: the four worst identity
// calls (165s avg, 3 never locked, incl. both Covina Valley calls) were all
// candidates count:1 at a verified company.
//
// Deliberately NOT lifted: fuzzy first names (Tanya -> Tony wrote a ticket to
// the wrong man, 2026-06-15) and multi-candidate ties. A caller who gave no
// surname can still reach this via the matcher's locked path for unique exact
// first names -- that is the matcher's call, not this one.
export function soleCandidateLock(verdict: MatchVerdict): PoolContact | null {
  if (verdict.status !== 'candidates') return null;
  if (verdict.count !== 1 || !verdict.sole) return null;
  return verdict.soleBasis === 'exact_first' ? verdict.sole : null;
}

// ─── S4: a retry that cannot change the answer is not asked for (2026-08-15) ─
// The candidates guidance used to instruct "ask the caller to confirm or spell
// their name, then lock again" -- but byte-identical input is deterministic.
// Five byte-identical multi-sends in two days (conv_8101 x3, conv_6501/8301/
// 1201 x2) prove the loop cannot converge; the Covina caller burned 175s and
// 247s in it and said "I wanna strangle this lady." A repeated identical
// attempt gets a decision, not another ask.
export const REPEAT_CANDIDATES_GUIDANCE =
  'This result is settled for the details given. Move forward with what the ' +
  'caller needs — answer, transfer, or take a message — and handle records per ' +
  'UNVERIFIED INTAKE.';

export const REPEAT_NEW_CONTACT_GUIDANCE =
  'This result is settled. Offer Identity Capture per the SOP now, or move ' +
  'forward with what the caller needs and let the closure record who called.';

/** Tracks identical lock attempts inside a short window (one conversation). */
export class RepeatedLockAttempts {
  private seen = new Map<string, number>();
  constructor(private ttlMs = 600_000, private maxEntries = 1000) {}
  private ts = new Map<string, number>();

  static key(callerPhone: string, companyId: unknown, first: string, last: string): string {
    const n = (x: unknown) => String(x ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    return [n(callerPhone), n(companyId), n(first), n(last)].join('|');
  }

  /** Returns how many times this exact attempt has been seen before (0 = first). */
  countAndRecord(key: string): number {
    const now = Date.now();
    const last = this.ts.get(key) ?? 0;
    if (now - last > this.ttlMs) this.seen.delete(key);
    if (this.seen.size >= this.maxEntries && !this.seen.has(key)) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) { this.seen.delete(oldest); this.ts.delete(oldest); }
    }
    const prior = this.seen.get(key) ?? 0;
    this.seen.set(key, prior + 1);
    this.ts.set(key, now);
    return prior;
  }
}

// ─── Distance-to-pool as computable confidence (2026-08-15, Brian) ───────────
// ElevenLabs exposes no STT confidence, and re-saying a name mostly reproduces
// the same transcription (five byte-identical lock attempts across two Covina
// calls). What we CAN measure is whether the spoken name sits just outside
// match range of someone on file -- the "Tom Daus heard as Tom Dev" class --
// versus nowhere near anyone, the genuinely-new-caller class. The first earns
// a spelling request (an independent channel); the second earns no re-ask at
// all.
export function nearestSurnameDistance(pool: PoolContact[], spokenLast?: string | null): number {
  const l = String(spokenLast ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (!l || pool.length === 0) return Infinity;
  let best = Infinity;
  for (const c of pool) {
    const toks = String(c.lastName ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').split(' ').filter(Boolean);
    for (const t of toks) best = Math.min(best, editDistance(l, t));
  }
  return best;
}

/** True when the spoken surname is a whisker outside match range of someone on file. */
export function isNearMissSurname(pool: PoolContact[], spokenLast?: string | null): boolean {
  const l = String(spokenLast ?? '').toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  if (!l) return false;
  const d = nearestSurnameDistance(pool, l);
  const t = threshold(l);
  return d > t && d <= t + 2;
}
