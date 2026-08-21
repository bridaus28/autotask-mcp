/**
 * Open-only ticket search default + labeled cap (patch 0008, 2026-08-21).
 *
 * Incident: conv_4901 08-21 10:09 (Leon, BEC/873). search_tickets returned the
 * company's full 90-day set — 287 rows, 250 of them Complete — plus a 30s
 * Autotask hang. The volume is the fixable half: a caller asking about a
 * ticket means open work, and closed tickets in the pile invite matching a
 * live call to a completed ticket (reopen risk, Brian's rule).
 *
 * The three approved pieces:
 *   1. open-only default   — no status + no searchTerm => excludeClosed
 *   2. scope label         — the filter is named, so "not in the list" can
 *                            never read as "does not exist"
 *   3. labeled 25-row cap  — partial views are marked, totals stay out
 *                            (no X-of-Y: a total is a number with no
 *                            conversational use that could get spoken)
 */
jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no live API in tests')) }
}));

import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { CLOSED_TICKET_STATUSES } from '../src/services/autotask.service';

const BEC = 873;

/** n open tickets, newest-first by id, mimicking the service's id DESC sort. */
function tickets(n: number, status = 1): any[] {
  return Array.from({ length: n }, (_, i) => ({
    id: 900000 - i,
    ticketNumber: `T20260821.${String(n - i).padStart(4, '0')}`,
    title: `Ticket ${n - i}`,
    status,
    companyID: BEC,
  }));
}

function makeHandler(rows: any[]) {
  const seenOptions: any[] = [];
  const service: any = {
    async searchTickets(opts: any) { seenOptions.push(opts); return rows; },
    async getCompany(id: number) { return id === BEC ? { id, companyName: 'Building Electronic Controls, Inc.' } : null; },
    async getContact() { return null; },
    testConnection: async () => true,
  };
  const handler = new AutotaskToolHandler(service, { info(){}, warn(){}, error(){}, debug(){} } as any);
  (handler as any).getMappingService = async () => ({ getCompanyName: async () => null, getResourceName: async () => null });
  (handler as any).picklistCache = { getPicklistValues: async () => null };
  return { handler, seenOptions };
}

const search = (h: any, args: any) => h.callTool('autotask_search_tickets', args);
const text = (r: any) => r.content.map((c: any) => c.text).join('');

describe('closed set is grounded, not assumed', () => {
  it('is exactly Complete (5) and RMM Complete (20) — verified live 2026-08-21', () => {
    expect([...CLOSED_TICKET_STATUSES]).toEqual([5, 20]);
  });
});

describe('when the open-only default applies', () => {
  it('company search with no status and no searchTerm sets excludeClosed', async () => {
    const { handler, seenOptions } = makeHandler(tickets(3));
    await search(handler, { companyID: BEC });
    expect(seenOptions[0].excludeClosed).toBe(true);
  });

  it('an explicit status is exempt — the filter steps aside', async () => {
    const { handler, seenOptions } = makeHandler(tickets(3, 5));
    const r = await search(handler, { companyID: BEC, status: 5 });
    expect(seenOptions[0].excludeClosed).toBeUndefined();
    expect(text(r)).not.toContain('open tickets');
  });

  it('a searchTerm (ticket-number lookup) is exempt — closed tickets stay findable', async () => {
    const { handler, seenOptions } = makeHandler(tickets(1, 5));
    const r = await search(handler, { searchTerm: 'T20260511.0088' });
    expect(seenOptions[0].excludeClosed).toBeUndefined();
    expect(text(r)).not.toContain('open tickets');
  });
});

describe('the scope label (the filter is named)', () => {
  it('under the cap: all rows returned, label says open, past work stays reachable', async () => {
    const { handler } = makeHandler(tickets(4));
    const out = text(await search(handler, { companyID: BEC }));
    expect(out).toContain('"returned":4');
    expect(out).toContain('All results are open tickets');
    expect(out).toContain('Completed work is available');
  });

  it('zero open tickets at a real company is labeled, never "no tickets ever"', async () => {
    const { handler } = makeHandler([]);
    const out = text(await search(handler, { companyID: BEC }));
    expect(out).toContain('open tickets');
    // The unknown-company classifier must NOT fire — BEC exists.
    expect(out).not.toContain('unknown_company');
  });

  it('guidance names only moves that exist: status id or ticket number, never a free-text keyword', async () => {
    const { handler } = makeHandler(tickets(4));
    const out = text(await search(handler, { companyID: BEC }));
    // searchTerm is ticketNumber-only by schema; a "keyword" instruction would
    // be a structurally-empty query (same class as the search_resources
    // full-name miss, d495f0a).
    expect(out).not.toMatch(/keyword/i);
    expect(out).toContain('status 5 (Complete)');
    expect(out).toContain('ticket number');
  });
});

describe('the labeled 25-row cap (BEC fires it on day one: 37 open)', () => {
  it('37 open rows -> the 25 newest, marked as a partial view without a total', async () => {
    const { handler } = makeHandler(tickets(37));
    const out = text(await search(handler, { companyID: BEC }));
    expect(out).toContain('"returned":25');
    expect(out).toContain('Showing the 25 most recent open tickets');
    expect(out).not.toMatch(/of 37|"total"/);   // no X-of-Y, the total stays out
    expect(out).toContain('900000');            // newest id survives the slice
    expect(out).not.toContain('"id":899975');   // 26th-newest does not
  });

  it('25 exactly: the cap is invisible and the ordinary open label stands', async () => {
    const { handler } = makeHandler(tickets(25));
    const out = text(await search(handler, { companyID: BEC }));
    expect(out).toContain('"returned":25');
    expect(out).toContain('All results are open tickets');
    expect(out).not.toContain('most recent open tickets');
  });

  it('explicit-status searches are never capped — the cap belongs to the open default only', async () => {
    const { handler } = makeHandler(tickets(40, 5));
    const out = text(await search(handler, { companyID: BEC, status: 5 }));
    expect(out).toContain('"returned":40');
  });
});

describe('affirmative-only lint (best practice: affirm the positive)', () => {
  it('no guidance string contains do-not/never phrasing', async () => {
    for (const rows of [tickets(4), tickets(37), []]) {
      const { handler } = makeHandler(rows);
      const out = text(await search(handler, { companyID: BEC }));
      expect(out).not.toMatch(/do not|don't|never/i);
    }
  });
});
