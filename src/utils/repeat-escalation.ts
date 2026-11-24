// ─── Repeat-contact escalation (2026-11-24, Brian) ────────────────────────────
//
// T20261123.0022 (Cal Blend Soils) sat at Low for four hours while the customer
// called three times and emailed once. Every call was documented; none of them
// raised the priority. Closure now raises the ticket a call lands on to High
// when either:
//
//   A. same_ticket   - the call lands on a ticket opened earlier the same
//                      Pacific day (a second call about the same thing), or
//   B. prior_contact - the caller says they already called, left messages,
//                      emailed, or that nobody got back to them.
//
// Per ticket, never per company: a company-level rule tested on 30 days fired
// on 82 company-days and would have raised 225 tickets; at BEC every hit was
// unrelated people with unrelated issues.
//
// Raise only. Critical and High are left alone. No notifications: one line in
// the closure note says why. Anything that fails leaves the ticket as it was.
//
// A call that lands on a ticket since merged follows the merge to the ticket
// that absorbed it, so the note and the priority go where staff are working.

const PRIOR_CONTACT_PATTERNS: RegExp[] = [
  // "I left two messages", "we had left a voicemail". First person only:
  // "they left a message" is someone returning a call, not a chaser.
  /\b(?:i|we)(?:'ve|'d| have| had)?\s+(?:already\s+)?left\s+(?:(?:a|an|one|two|three|four|several|multiple|\d+|a\s+couple(?:\s+of)?)\s+)?(?:voice\s*)?(?:messages?|voicemails?)\b/i,
  /\b(?:i|we)(?:'ve| have)?\s+already\s+(?:called|emailed|e-mailed|sent|left|reached\s+out|submitted|put\s+in)\b/i,
  /\b(?:i|we)(?:'ve| have)?\s+(?:called|been\s+calling)\s+(?:earlier|before|this\s+morning|yesterday|twice|already|three\s+times|several\s+times|multiple\s+times|a\s+few\s+times|all\s+day|all\s+morning)\b/i,
  /\b(?:no\s*one|nobody)(?:'s|\s+has|\s+ever)?\s+(?:called|answered|got\s+back|gotten\s+back|responded|returned|picked\s+up)\b/i,
  /\b(?:i|we)\s+(?:haven't|have\s+not|never)\s+(?:heard|gotten\s+a\s+call|got\s+a\s+call|received\s+a\s+call)\b/i,
  /\bsupposed\s+to\s+(?:get|receive)\s+a\s+call\s*-?\s*back\b/i,
  /\bstill\s+waiting\b/i,
  /\b(?:second|third|fourth)\s+time\s+(?:i'm|i\s+am|i've|we're|calling)\b/i,
];

/** The caller's own words, not Ivy's, say this is not the first contact. */
export function callerReportsPriorContact(transcript: any[] | undefined): boolean {
  for (const turn of transcript || []) {
    if (turn?.role !== 'user' || typeof turn.message !== 'string') continue;
    if (PRIOR_CONTACT_PATTERNS.some(p => p.test(turn.message))) return true;
  }
  return false;
}

const PACIFIC_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
});

/** Opened before this call started, on the same Pacific calendar day. */
export function openedEarlierSameDay(ticketCreateDate: string | undefined, callStartMs: number): boolean {
  if (!ticketCreateDate) return false;
  const created = Date.parse(ticketCreateDate);
  if (!Number.isFinite(created) || created >= callStartMs) return false;
  return PACIFIC_DAY.format(created) === PACIFIC_DAY.format(callStartMs);
}

export interface PriorityOption { value: string; label: string }

/** Critical > High > Medium/Normal > Low, by label so tenant IDs don't matter. */
export function priorityRank(label: string | undefined): number {
  const l = (label || '').toLowerCase();
  if (l.includes('critical')) return 4;
  if (l.includes('high')) return 3;
  if (l.includes('medium') || l.includes('normal')) return 2;
  if (l.includes('low')) return 1;
  return 0;
}

const MERGED_INTO = /merged\s+into\s+(T\d{8}\.\d{4})/i;

export interface EscalationDeps {
  getTicket(id: number): Promise<any | null>;
  searchTicketNotes(ticketId: number): Promise<any[]>;
  findTicketByNumber(ticketNumber: string): Promise<any | null>;
  updateTicket(id: number, updates: Record<string, any>): Promise<void>;
  getPriorities(): Promise<PriorityOption[]>;
  warn?(msg: string, meta?: any): void;
}

export interface EscalationResult {
  /** Where the closure note should go (the merge target when the ticket was merged). */
  ticketId: number;
  /** Line to append to the closure note, or null when nothing changed. */
  line: string | null;
}

/** Follow up to three merges. Returns the open ticket staff are working, or the original. */
async function followMerges(deps: EscalationDeps, ticket: any): Promise<any> {
  let current = ticket;
  for (let hop = 0; hop < 3 && current?.status === 5; hop++) {
    const notes = await deps.searchTicketNotes(current.id);
    const hit = notes.map(n => String(n?.description || '')).map(d => d.match(MERGED_INTO)).find(Boolean);
    if (!hit) break;
    const target = await deps.findTicketByNumber(hit[1]);
    if (!target?.id || target.id === current.id) break;
    current = target;
  }
  return current;
}

export async function escalateOnRepeat(
  deps: EscalationDeps,
  boundTicketId: number,
  callStartMs: number,
  transcript: any[] | undefined,
): Promise<EscalationResult> {
  const unchanged: EscalationResult = { ticketId: boundTicketId, line: null };
  try {
    const bound = await deps.getTicket(boundTicketId);
    if (!bound) return unchanged;
    const target = await followMerges(deps, bound);
    const result: EscalationResult = { ticketId: target.id ?? boundTicketId, line: null };
    if (target.status === 5) return result; // completed, not merged: leave it alone

    const sameTicket = openedEarlierSameDay(bound.createDate, callStartMs);
    const priorContact = callerReportsPriorContact(transcript);
    if (!sameTicket && !priorContact) return result;

    const priorities = await deps.getPriorities();
    const high = priorities.find(p => priorityRank(p.label) === 3);
    const current = priorities.find(p => Number(p.value) === Number(target.priority));
    if (!high || priorityRank(current?.label) >= 3) return result;

    await deps.updateTicket(target.id, { priority: Number(high.value) });
    const why = sameTicket
      ? 'another call today about this ticket'
      : 'the caller says they already called, emailed or left a message';
    result.line = `Priority raised to High: ${why}.`;
    return result;
  } catch (err) {
    deps.warn?.('Repeat escalation failed, ticket left as is', { boundTicketId, err: (err as Error)?.message });
    return unchanged;
  }
}
