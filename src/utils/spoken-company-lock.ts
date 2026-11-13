/**
 * Unknown phone, company named by the caller (2026-11-12, Brian).
 *
 * On a phone that matches nothing, the lock used to ignore spoken_company and
 * answer no_record. Ivy then improvised: search_companies, then lock again
 * with company_id. Over 10-29..11-12 she did that on some calls and not on
 * others: three callers who gave full names never locked.
 *
 * This lets the server do the same thing every time, under a stricter rule
 * than the company_id path, because nothing here is vouched for by the phone:
 *   - exactly one active, non-residential company matches the spoken name;
 *   - the caller gave a first AND last name, and both match one contact there
 *     exactly. No sole-candidate lift, no spelling variants, no fuzzy surname.
 * Anything short of that returns what it returned before.
 */
import { matchSpokenName, PoolContact } from './name-match.js';

/** Legal suffixes dropped from both sides before comparing. */
const LEGAL_SUFFIXES = new Set(['inc', 'incorporated', 'llc', 'corp', 'corporation', 'co', 'ltd', 'llp', 'pc', 'aplc']);

/** Letters and digits only, legal suffix words removed. "Rod Show's" -> "rodshows". */
export function companyKey(name: unknown): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !LEGAL_SUFFIXES.has(w))
    .join('');
}

/**
 * The word sent to Autotask's `contains` query: the longest word of the spoken
 * name, apostrophes removed. The real comparison happens locally on companyKey.
 * Returns '' when nothing usable was said.
 */
export function companySearchWord(spoken: unknown): string {
  const words = String(spoken ?? '')
    .replace(/['’]/g, '')
    .split(/[^A-Za-z0-9&]+/)
    .filter((w) => w.length >= 3 && !LEGAL_SUFFIXES.has(w.toLowerCase()));
  return words.sort((a, b) => b.length - a.length)[0] ?? '';
}

export interface CompanyRow {
  id: number;
  companyName?: string | null;
  isResidential?: boolean;
}

/** The one company the spoken name points at, or null when it is not exactly one. */
export function pickSpokenCompany(rows: CompanyRow[], spoken: unknown): CompanyRow | null {
  const key = companyKey(spoken);
  if (key.length < 3) return null;
  const hits = rows.filter((r) => !r.isResidential && companyKey(r.companyName).includes(key));
  return hits.length === 1 ? hits[0] : null;
}

/** The one contact whose first and last name both match exactly, or null. */
export function exactFullNameLock(pool: PoolContact[], first: unknown, last: unknown): PoolContact | null {
  const f = String(first ?? '').trim();
  const l = String(last ?? '').trim();
  if (!f || !l) return null;
  const v = matchSpokenName(pool, f, l);
  return v.status === 'locked' && v.match === 'exact' ? v.contact : null;
}

/**
 * Rider on a lock made this way. The phone is not on file, so the account was
 * matched on what the caller said. Prompt line 49 scopes access by phone; this
 * keeps that true without blocking help.
 */
export const SPOKEN_COMPANY_SCOPE_RIDER =
  'This phone is not on file, so the match rests on what the caller said. Help with the call, open new work, take messages and transfer as usual. Keep what is on file unspoken: existing tickets, their details, and other people at the account.';

/**
 * no_record on an unknown phone when the caller named a company but no last
 * name. Worded the same whether or not the company exists, so the answer
 * reveals nothing about who is a customer.
 */
export const SPOKEN_COMPANY_NEED_LAST_GUIDANCE =
  'Ask for their last name, then call again with spoken_first, spoken_last and spoken_company.';

/**
 * no_record on an unknown phone when no company has been given yet. The caller's
 * company is the one thing that can still place them, and it belongs in this
 * tool, not in a separate company search.
 */
export const SPOKEN_COMPANY_ASK_GUIDANCE =
  'When the caller names a business, call again with spoken_first, spoken_last and spoken_company in their words.';
