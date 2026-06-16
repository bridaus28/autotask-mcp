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
    const allToks = [...tokens(c.firstName), ...lastToks];
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
    if (lastMatches.length === 0) return { status: 'new_contact' };
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
