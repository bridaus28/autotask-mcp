/**
 * Internal identification clues for an unidentified caller's closure report
 * (2026-11-02). The old line said "no record on file" for every caller the
 * call did not identify, including a phone on file at two accounts, which sent
 * staff looking for a new customer. These lines tell staff what we do know:
 * the name the caller gave and which accounts the phone belongs to.
 *
 * Staff-only by construction: an unidentified caller's ticket lands on the
 * catch-all company and closure notes are publish=2. Never spoken; the closure
 * runs after the call. Lists accounts, never picks one.
 */
import { PoolContact, isPlaceholderSpokenName } from './name-match.js';

export const MAX_ACCOUNTS = 5;
export const MAX_NAMES_PER_ACCOUNT = 3;

export interface PhoneAccountLike {
  pool: PoolContact[];
  companyIds: number[];
  via: 'contacts' | 'company_main_phone' | 'none';
}

/** The last name the caller gave, as Ivy passed it to autotask_lock_contact. */
export function lastSpokenName(transcript: any[] | null | undefined): string | null {
  let found: string | null = null;
  for (const turn of transcript || []) {
    for (const tc of turn?.tool_calls || []) {
      if (!String(tc?.tool_name || '').endsWith('autotask_lock_contact')) continue;
      let p: any = tc.params_as_json;
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch { continue; } }
      const first = String(p?.spoken_first ?? '').trim();
      const last = String(p?.spoken_last ?? '').trim();
      if (!first && !last) continue;
      if (isPlaceholderSpokenName(first, last)) continue;
      found = [first, last].filter(Boolean).join(' ');
    }
  }
  return found;
}

const fullName = (c: PoolContact) => [c.firstName, c.lastName].map(s => String(s ?? '').trim()).filter(Boolean).join(' ');

/** Pure formatter. companyNames maps companyID to its display name. */
export function unidentifiedCallerLines(
  spokenName: string | null,
  account: PhoneAccountLike | null,
  companyNames: Map<number, string>,
  callerPhone: string,
): string[] {
  const lines = ['Caller: Unidentified'];
  if (spokenName) lines.push(`Name given on call: ${spokenName}`);
  const ids = account?.companyIds ?? [];
  if (!account || ids.length === 0) {
    lines.push(`Phone: no record on file for ${callerPhone}`);
    return lines;
  }
  const label = (id: number) => companyNames.get(id) || `company ${id}`;
  if (account.via === 'company_main_phone') {
    lines.push(`Phone matches the main number of ${label(ids[0])}`);
    return lines;
  }
  lines.push(ids.length === 1 ? 'Phone on file at 1 account:' : `Phone on file at ${ids.length} accounts:`);
  for (const id of ids.slice(0, MAX_ACCOUNTS)) {
    const names = [...new Set(account.pool.filter(c => c.companyID === id).map(fullName).filter(Boolean))];
    const shown = names.slice(0, MAX_NAMES_PER_ACCOUNT).join(', ');
    const more = names.length > MAX_NAMES_PER_ACCOUNT ? ` (+${names.length - MAX_NAMES_PER_ACCOUNT} more)` : '';
    lines.push(`  - ${label(id)}${shown ? `: ${shown}${more}` : ''}`);
  }
  if (ids.length > MAX_ACCOUNTS) lines.push(`  - (+${ids.length - MAX_ACCOUNTS} more accounts)`);
  return lines;
}

/**
 * Looks up the phone and company names, then formats. Any failure returns the
 * old single line, so the closure always writes.
 */
export async function buildUnidentifiedCallerLines(
  resolve: (phone: string) => Promise<PhoneAccountLike>,
  getCompanyName: (id: number) => Promise<string | null>,
  callerPhone: string,
  transcript: any[] | null | undefined,
): Promise<string[]> {
  const fallback = [`Caller: Unidentified (no record on file for ${callerPhone})`];
  try {
    const spoken = lastSpokenName(transcript);
    if (!callerPhone || callerPhone === 'Unknown') {
      return spoken ? ['Caller: Unidentified', `Name given on call: ${spoken}`] : fallback;
    }
    const account = await resolve(callerPhone);
    const names = new Map<number, string>();
    for (const id of (account?.companyIds ?? []).slice(0, MAX_ACCOUNTS)) {
      try { const n = await getCompanyName(id); if (n) names.set(id, n); } catch { /* label falls back to the id */ }
    }
    return unidentifiedCallerLines(spoken, account, names, callerPhone);
  } catch {
    return fallback;
  }
}
