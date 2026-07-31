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
  | { status: 'candidates'; count: number }
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
      return viaFirst.status === 'locked' ? { status: 'candidates', count: 1 } : viaFirst;
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
  return { status: 'candidates', count: exact.length > 1 ? exact.length : firstMatches.length };
}
