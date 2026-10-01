// ─── Ticket queue routing (2026-09-30) ──────────────────────────────────────
//
// Every ticket Ivy created since the receptionist went live landed in the
// ticket category's default queue: 220 of 220 create_ticket calls in
// 08-30..09-29 passed no queueID. Dispatch then moved residential repairs
// into Shop by hand (24 of 151 in 09-16..09-29). The rule dispatch was
// applying is the account's classification, not the device or the words, so
// the server applies it at create and the agent is never asked to.
//
// Autotask ticket queues, picklist on Tickets.queueID (this tenant):
//   Shop      29683484   residential accounts (Companies.classification 13)
//   Leads     29683483   unverified callers (catch-all company 0)
//   Support 1 29682833   everything else
//
// These are Autotask ticket queues. The 1Stream/BVOIP phone queues
// (8000/8002/8003/8004) are a different system with a different map; see
// /resolve-extension. Do not route one by the other.

export const QUEUE_SHOP = 29683484;
export const QUEUE_LEADS = 29683483;
export const QUEUE_SUPPORT_1 = 29682833;

/** Companies.classification picklist value for a residential (home) account. */
export const CLASSIFICATION_RESIDENTIAL = 13;

/** The catch-all company that unverified callers' tickets are written to. */
export const CATCH_ALL_COMPANY_ID = 0;

/**
 * Which Autotask queue a new ticket belongs in, from the account it is for.
 * `classification` is the company's Companies.classification value, or null
 * when the company could not be read; an unreadable company is business by
 * default, because Support 1 is where a human looks first.
 */
export function queueForTicket(companyID: number | null | undefined, classification: number | null | undefined): number {
  const company = Number(companyID);
  if (!Number.isFinite(company) || company === CATCH_ALL_COMPANY_ID) return QUEUE_LEADS;
  if (Number(classification) === CLASSIFICATION_RESIDENTIAL) return QUEUE_SHOP;
  return QUEUE_SUPPORT_1;
}

/**
 * The rule applied end to end: read the company's classification (unless it
 * is the catch-all) and return the queue. Used by both places a ticket is
 * created for a caller: the agent's autotask_create_ticket and the
 * call-closure report. A failed company read is logged and routes to
 * Support 1; it never blocks the ticket.
 */
export async function resolveQueueID(
  companyID: number | null | undefined,
  getCompany: (id: number) => Promise<any>,
  logger?: { warn: (msg: string, meta?: any) => void },
): Promise<number> {
  let classification: number | null = null;
  const id = Number(companyID);
  if (Number.isFinite(id) && id !== CATCH_ALL_COMPANY_ID) {
    try {
      const co: any = await getCompany(id);
      classification = co?.classification != null ? Number(co.classification) : null;
    } catch (e) {
      logger?.warn('ticket queue: company read failed; routing to Support 1', { companyID, error: (e as Error)?.message });
    }
  }
  return queueForTicket(companyID, classification);
}
