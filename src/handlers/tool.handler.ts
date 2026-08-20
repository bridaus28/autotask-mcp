// Autotask Tool Handler
// Handles MCP tool calls for Autotask operations (search, create, update)

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { AutotaskService, resolveTicketQuery, isNotFoundError, isExactPhoneMatch } from '../services/autotask.service.js';
import { matchSpokenName, isPlaceholderSpokenName, isCompanyNameAsSurname } from '../utils/name-match.js';
import { RecentWrites } from '../utils/recent-writes.js';
import { PicklistCache, PicklistValue } from '../services/picklist.cache.js';
import { Logger } from '../utils/logger.js';
import { formatCompactResponse, detectEntityType, COMPACT_SEARCH_TOOLS } from '../utils/response.formatter.js';
import { MappingService } from '../utils/mapping.service.js';
import { TOOL_DEFINITIONS } from './tool.definitions.js';

// ─── Email values that are NOT identity ──────────────────────────────────────
// Sentinels used where a real address is unknown. Measured against live
// Autotask 2026-08-05 over 10,226 contacts: noemail@contoso.com 2,222 rows,
// noemail@computervillage.com 80, the literal 'unknown' 28, na@na.com 3.
// Matching on these would collide almost every emailless create.
const PLACEHOLDER_EMAILS = new Set<string>([
  'noemail@contoso.com',
  'noemail@computervillage.com',
  'unknown',
  'na@na.com',
  'n/a',
  'none',
  'noemail',
]);

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// ─── Statuses a caller-visible note may advance to "Customer Noted" ───────────
// ALLOWLIST, not a denylist. Ivy may only move a ticket to Customer Noted from a
// status where doing so is safe. Anything not listed is left alone.
//
// Deliberately EXCLUDED and why:
//   10 Dispatched          a tech is assigned out or en route; moving it off the
//                          dispatch board loses the assignment
//   29 Scheduled           an appointment is booked; same problem
//    5 Complete            reopening is a deliberate act, not a side effect. The
//                          KB's <=7-day rule has Ivy reopen to Customer Noted via
//                          autotask_update_ticket FIRST, so by note time the
//                          status is already 19 and this is a no-op anyway
//   20 RMM Complete        closed by automation
//   25 Escalate from MC / 26 MC - Needs Info / 27 MC - Out of Scope /
//   28 Escalate to MC      co-managed escalation workflow, not ours to unwind
//
// Source: Brian, 2026-07-26. Resolved against live Autotask the same day (18
// statuses total). Tenant-specific ids — mirror any change in ITGlue.
const CUSTOMER_NOTED_SOURCE_STATUSES = new Set<number>([
  1,   // New
  7,   // Waiting Customer
  8,   // In Progress
  9,   // Waiting Materials
  12,  // Waiting Vendor
  21,  // Follow up
  22,  // Ready Delivery
  23,  // Ready Pickup
  24,  // Waiting Notes
]);


// Zero-result fallback for multi-word company searches (2026-06-12).
// Autotask searchTerm is an exact-substring contains match, so STT-garbled
// multi-word names ("RG Rubber") return 0 even when a single distinctive
// token ("Rubber") matches uniquely. The retry rule lived in the tool
// description and failed to fire 3x in 3 days (conv_6801, conv_0201,
// conv_8501) — moved server-side where it always fires. Single-word zero
// results are NOT retried: a genuine miss must stay a miss.
const FALLBACK_STOPWORDS = new Set([
  'inc', 'llc', 'corp', 'co', 'ltd', 'the', 'and', 'of', 'a', 'an',
  'company', 'companies', 'group', 'services', 'service', 'solutions',
  'technologies', 'technology', 'systems', 'enterprises', 'associates',
  'office', 'offices', 'llp', 'aplc', 'pc',
]);
function companyFallbackTokens(term: string): string[] {
  return term
    .split(/[^a-zA-Z0-9&']+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 4 && !FALLBACK_STOPWORDS.has(t.toLowerCase()))
    .sort((x, y) => y.length - x.length)
    .slice(0, 2);
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface McpToolResult {
  content: Array<{
    type: string;
    text: string;
  }>;
  isError?: boolean;
  data?: any;
}

// Tools that should NOT have company/resource names resolved via the mapping
// service. These are identity or high-frequency tools where name resolution
// adds unnecessary API calls without providing value to the caller.
const SKIP_ENHANCEMENT_TOOLS = new Set([
  'autotask_search_contacts',
  'autotask_get_contact',
]);

// B15: domains that identify a PERSON, not a company. A contact email on one
// of these never becomes an account's web domain.
const FREEMAIL_DOMAINS = new Set<string>([
  'gmail.com','yahoo.com','ymail.com','hotmail.com','outlook.com','aol.com',
  'icloud.com','me.com','mac.com','msn.com','live.com','protonmail.com','proton.me',
  'gmx.com','mail.com','comcast.net','att.net','sbcglobal.net','verizon.net',
  'cox.net','charter.net','roadrunner.com','earthlink.net','pacbell.net',
]);

export class AutotaskToolHandler {
  protected autotaskService: AutotaskService;
  protected logger: Logger;
  protected picklistCache: PicklistCache;
  protected mcpServer: Server | null = null;
  private mappingService: MappingService | null = null;

  private recentCreates = new RecentWrites();

  constructor(autotaskService: AutotaskService, logger: Logger) {
    this.autotaskService = autotaskService;
    this.logger = logger;
    this.picklistCache = new PicklistCache(
      logger,
      (entityType) => this.autotaskService.getFieldInfo(entityType)
    );
  }

  private async getMappingService(): Promise<MappingService> {
    if (!this.mappingService) {
      this.mappingService = await MappingService.getInstance(this.autotaskService, this.logger);
    }
    return this.mappingService;
  }

  /**
   * Enhance items by inlining company/resource names from IDs
   */
  private async enhanceItems(items: any[]): Promise<any[]> {
    try {
      const mappingService = await this.getMappingService();
      const enhanced = await Promise.allSettled(
        items.map(async (item) => {
          const result = { ...item };
          if (item.companyID != null && typeof item.companyID === 'number') {
            try {
              const name = await mappingService.getCompanyName(item.companyID);
              if (name) result.company = name;
            } catch { /* skip */ }
          }
          if (item.assignedResourceID != null && typeof item.assignedResourceID === 'number') {
            try {
              const name = await mappingService.getResourceName(item.assignedResourceID);
              if (name) result.assignedTo = name;
            } catch { /* skip */ }
          }
          if (item.projectLeadResourceID != null && typeof item.projectLeadResourceID === 'number') {
            try {
              const name = await mappingService.getResourceName(item.projectLeadResourceID);
              if (name) result.lead = name;
            } catch { /* skip */ }
          }
          return result;
        })
      );
      return enhanced
        .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
        .map(r => r.value);
    } catch (error) {
      this.logger.debug('Enhancement failed, returning original items:', error);
      return items;
    }
  }

  /**
   * Set the MCP server reference for elicitation support
   */
  setServer(server: Server): void {
    this.mcpServer = server;
  }

  /**
   * Elicit user input for a selection from picklist values.
   * Falls back to returning null if elicitation is not supported by the client.
   */
  protected async elicitSelection(
    message: string,
    fieldName: string,
    options: PicklistValue[]
  ): Promise<string | null> {
    if (!this.mcpServer) return null;

    try {
      const result = await this.mcpServer.elicitInput({
        message,
        requestedSchema: {
          type: 'object' as const,
          properties: {
            [fieldName]: {
              type: 'string' as const,
              title: fieldName,
              description: `Select a ${fieldName}`,
              enum: options.map(o => o.value),
              enumNames: options.map(o => o.label),
            }
          },
          required: [fieldName],
        }
      });

      if (result.action === 'accept' && result.content) {
        return result.content[fieldName] as string;
      }
      return null;
    } catch (error) {
      // Client likely doesn't support elicitation — not an error
      this.logger.debug(`Elicitation not available: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }

  /**
   * Elicit a date range filter when no filters are provided for ticket search.
   * Returns date filter params or null if elicitation is not available/dismissed.
   * Times out after 5 seconds to avoid blocking in non-interactive environments.
   */
  protected async elicitDateRange(): Promise<Record<string, string> | null> {
    if (!this.mcpServer) return null;

    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('elicitation timeout')), 5000)
      );
      const result = await Promise.race([this.mcpServer.elicitInput({
        message: 'No filters specified. What date range would you like to search?',
        requestedSchema: {
          type: 'object' as const,
          properties: {
            dateRange: {
              type: 'string' as const,
              title: 'Date Range',
              description: 'How far back to search',
              enum: ['today', 'past_week', 'past_month', 'past_quarter', 'all'],
              enumNames: ['Today', 'Past Week', 'Past Month', 'Past Quarter', 'All Time'],
            }
          },
          required: ['dateRange'],
        }
      }), timeoutPromise]);

      if (result.action === 'accept' && result.content) {
        const range = result.content.dateRange as string;
        const now = new Date();
        let createdAfter: string | undefined;

        switch (range) {
          case 'today':
            createdAfter = now.toISOString().split('T')[0];
            break;
          case 'past_week':
            now.setDate(now.getDate() - 7);
            createdAfter = now.toISOString().split('T')[0];
            break;
          case 'past_month':
            now.setMonth(now.getMonth() - 1);
            createdAfter = now.toISOString().split('T')[0];
            break;
          case 'past_quarter':
            now.setMonth(now.getMonth() - 3);
            createdAfter = now.toISOString().split('T')[0];
            break;
          case 'all':
          default:
            return null; // No date filter
        }

        if (createdAfter) {
          return { createdAfter };
        }
      }
      return null;
    } catch (error) {
      this.logger.debug(`Date range elicitation not available: ${error instanceof Error ? error.message : 'unknown'}`);
      return null;
    }
  }

  /**
   * List all available tools
   */
  async listTools(): Promise<McpTool[]> {
    this.logger.debug(`Listed ${TOOL_DEFINITIONS.length} available tools`);
    return TOOL_DEFINITIONS;
  }

  /**
   * Dispatch table: maps tool names to handler functions
   */
  private getDispatchTable(): Map<string, (args: any) => Promise<{ result: any; message: string; hint?: string; effectivePageSize?: number }>> {
    const s = this.autotaskService;
    // Short-window duplicate-create memo, per handler instance (one long-lived
    // instance in production). See utils/recent-writes.ts for the incidents.
    const RECENT_CREATES = this.recentCreates;
    type H = (args: any) => Promise<{ result: any; message: string; hint?: string; effectivePageSize?: number }>;
    return new Map<string, H>([
      // Connection
      ['think', async () => {
        // Deliberate no-op: the value is the designated reasoning space.
        return { result: 'ok', message: 'Thought logged.' };
      }],
      ['autotask_test_connection', async () => {
        const ok = await s.testConnection();
        return { result: { success: ok }, message: ok ? 'Successfully connected to Autotask API' : 'Connection failed' };
      }],

      // Companies
      ['autotask_search_companies', async (a) => {
        if (a.id != null) {
          const r = await s.getCompany(a.id);
          return { result: { company: r }, message: 'Company retrieved successfully' };
        }
        // Active-only unless explicitly asked otherwise. An inactive company is a
        // historical record and offering one as a match is worse than finding nothing:
        // 2026-08-03 07:09 a search for "IDW" returned active 706 "Innovative
        // DisplayWorks Inc. (IDW)" AND inactive 5131 "IDW", and both names plus both
        // account statuses were read aloud to a caller who was not yet identified.
        // Verified against live Autotask 2026-08-03: isActive true returns 11 of the 15
        // "Miller" rows, false returns the other 4, so the filter is applied in the query.
        const activeOnly = { ...a, isActive: a.isActive ?? true };
        let r = await s.searchCompanies(activeOnly);
        let hint: string | undefined;
        const term = typeof a.searchTerm === 'string' ? a.searchTerm.trim() : '';
        if (r.length === 0 && term.length > 0 && /\s/.test(term)) {
          for (const token of companyFallbackTokens(term)) {
            r = await s.searchCompanies({ ...activeOnly, searchTerm: token });
            if (r.length > 0) {
              hint = `0 results for "${term}"; matched on fallback token "${token}". Confirm against the caller-stated company name before use.`;
              break;
            }
          }
        }
        // An empty array reads as "this company is not a customer", and that is not
        // what a zero-result substring search establishes. Measured 06-24..07-30:
        // 32 of 85 company searches returned zero, and on 07-30 one of them turned a
        // managed client into an offer to open a new account (conv_...0v9svxdnyryx,
        // "Sunseri's" transcribed "Sunfuries"). Report the fact instead. Deliberately
        // carries NO receptionist policy -- what to do about a no_match is the
        // consumer's decision and lives in the KB.
        if (r.length === 0 && term.length > 0) {
          return {
            result: { status: 'no_match', searchTerm: term, matchType: 'substring' },
            message: `No company name contains "${term}". This is a literal substring match, not a fuzzy one, so a misspelling or a partial word returns zero even when the company exists. A corrected spelling or a different distinctive word from the name may succeed.`,
          };
        }
        return { result: r, message: `Found ${r.length} companies`, hint };
      }],
      ['autotask_create_company', async (a) => {
        // customer_type drives routing-relevant classification (ROUTING_VALIDATION_2026-06-12):
        // residential accounts misroute to Business Support unless classified at create time.
        const { customer_type, ...rest } = a;
        if (customer_type !== 'business' && customer_type !== 'residential') {
          throw new Error('customer_type is required and must be "business" or "residential". Ask the caller which they are if unclear.');
        }
        const phoneDigits = String(rest.phone ?? '').replace(/\D/g, '');
        if (phoneDigits.length < 7) {
          throw new Error('phone must be the caller\'s real phone number (the number they are calling from). Placeholders are not accepted.');
        }
        if (customer_type === 'residential') {
          rest.classification = 13;      // Residential — verified live 2026-06-12
          rest.companyCategoryID = 100;  // residential category — verified live 2026-06-12
        }
        const coKey = RecentWrites.key('company', { companyName: rest.companyName, phone: phoneDigits });
        const coReplay = RECENT_CREATES.check(coKey);
        if (coReplay !== undefined) return coReplay;
        // ── B14 (2026-08-17): phone-first dedupe against Autotask itself ────
        // The KB has said "the server dedupes by phone first, then name" since
        // v2; until today only the same-call replay memo existed, and the
        // master test proved it: an exact-phone duplicate (probe co 7700
        // against co 175) sailed through. A company already holding this
        // phone IS this caller's account; return it instead of duplicating.
        // Exact-name match backs the phone check for number-less accounts.
        try {
          const byPhone = await s.searchCompanies({ phone: phoneDigits } as any);
          const hit = (byPhone || []).find((c: any) => c.isActive !== 0 && c.isActive !== false)
            || (byPhone || [])[0]
            || (await s.searchCompanies({ searchTerm: rest.companyName } as any) || [])
               .find((c: any) => String(c.companyName ?? '').trim().toLowerCase() === String(rest.companyName ?? '').trim().toLowerCase());
          if (hit) {
            const dedupe = {
              result: { status: 'existing_company', created: false, id: hit.id, companyName: hit.companyName ?? null },
              message: `Not created. An account already holds this phone or name: "${hit.companyName}" (id ${hit.id}). Use that account for this caller; a technician can merge or correct records later.`,
            };
            RECENT_CREATES.record(coKey, dedupe);
            return dedupe;
          }
        } catch { /* dedupe is best-effort; a lookup failure falls through to create */ }
        const id = await s.createCompany(rest);
        const coOutcome = { result: id, message: `Successfully created company with ID: ${id}` };
        RECENT_CREATES.record(coKey, coOutcome);
        return coOutcome;
      }],
      ['autotask_update_company', async (a) => {
        await s.updateCompany(a.id, a); return { result: undefined, message: `Successfully updated company ID: ${a.id}` };
      }],

      // Contacts
      ['autotask_search_contacts', async (a) => {
        const r = await s.searchContacts(a);
        return { result: r, message: `Found ${r.length} contacts` };
      }],
      ['autotask_get_contact', async (a) => {
        const r = await s.getContact(a.contactId);
        return { result: { contact: r }, message: 'Contact retrieved successfully' };
      }],
      ['autotask_create_contact', async (a) => {
        // ══ NAME GUARDS (S2, 2026-08-15) ═══════════════════════════════════
        // The same disease the lock's placeholder refusal treats, at a door
        // that writes durable records. conv_3901 (08-12) sent an empty
        // lastName straight through to an Autotask 500; "Alma South Hills
        // Escrow" (08-10) put the company in the surname field and only the
        // phone gate stopped the write.
        const firstNameIn = String(a.firstName ?? '').trim();
        const lastNameIn  = String(a.lastName ?? '').trim();
        if (!lastNameIn) {
          return {
            result: { status: 'last_name_required', created: false },
            message:
              'Not created. The record needs a last name. Ask the caller for their ' +
              'last name, then call again with lastName set to their answer.',
          };
        }
        if (isPlaceholderSpokenName(firstNameIn, lastNameIn)) {
          return {
            result: { status: 'placeholder_name', created: false },
            message:
              'Not created. Ask who you are speaking with and use their answer. ' +
              'Never use a name the caller did not say.',
          };
        }
        let companyNameForGuard: string | null = null;
        try {
          const coForGuard: any = await s.getCompany(a.companyID);
          companyNameForGuard = coForGuard?.companyName ?? null;
        } catch { /* fail open: worst case here is record quality, not access */ }
        if (isCompanyNameAsSurname(lastNameIn, companyNameForGuard)) {
          return {
            result: { status: 'company_name_as_surname', created: false },
            message:
              'Not created. lastName looks like a company name rather than a ' +
              "person's surname. The company belongs in companyID only; ask the " +
              'caller for their own last name, then call again.',
          };
        }

        // ══ DUPLICATE-CREATE REPLAY ═════════════════════════════════════════
        // Identical create seen seconds ago on this instance: return the first
        // outcome, write nothing. The retry-after-abandon pattern.
        const replayKey = RecentWrites.key('contact', {
          companyID: a.companyID, firstName: firstNameIn, lastName: lastNameIn,
          emailAddress: a.emailAddress, callerPhone: a.callerPhone,
        });
        const replayed = RECENT_CREATES.check(replayKey);
        if (replayed !== undefined) return replayed;

        // ══ ACCESS GATE ═══════════════════════════════════════════════════
        // Creating a contact IS granting access. The pre-call webhook matches
        // inbound calls on contact phone/mobilePhone, so a contact carrying the
        // caller's number makes every future call from it read
        // "Verified caller: <name> at <company>", and Ivy then discusses that
        // company's open work.
        //
        // Measured 2026-08-05 over the 32 contacts Ivy created in 30 days: 29
        // recorded the caller's own caller ID, and 9 of those went to an
        // established company from a phone that was not on file at all. Five
        // spot-checked against live Autotask are now active contacts at RD
        // Rubber, All-Pro, Airey-Thompson, PJ Hilton and Inland Commercial. A
        // caller only had to say a name and a company.
        //
        // Nothing said on a call proves affiliation. The one thing a caller
        // cannot fabricate by talking is the number they are dialling from,
        // because Twilio resolves it before Ivy speaks. So the gate hangs off
        // that and nothing else. Brian's decision, 2026-08-05.
        //
        // Applies ONLY to companies that already hold a contact. A brand-new
        // account being opened on this call -- residential OR business, both
        // happen -- creates the company and its first contact seconds apart,
        // has no existing data to expose, and is untouched. 16 of the 32.
        //
        // Note the one way round this is to create a DUPLICATE company and put
        // the contact on that. It grants no access (the shadow account is
        // empty, the real one is untouched), so it is a record-quality problem
        // and not a security one -- tracked separately with the IDW and
        // Salvador Pablo duplicates.
        const targetCompanyID = a.companyID;
        let established: boolean;
        try {
          established = await s.companyHasContacts(targetCompanyID);
        } catch (err) {
          // FAILS CLOSED. Every other guard in this file fails open because the
          // worst case is a duplicate. Here the worst case is another
          // customer's data, so an unknown answer refuses.
          this.logger.error('Access gate could not determine company state; refusing', { err, targetCompanyID });
          return {
            result: { status: 'gate_unavailable', created: false },
            message:
              'Not created. The account could not be checked just now, so a contact ' +
              'cannot be added to it. Open the ticket for the company without a contact ' +
              'and record who called; a technician will attach them.',
          };
        }

        if (established) {
          const callerPhone = String(a.callerPhone ?? '').trim();
          if (!callerPhone) {
            this.logger.warn('Access gate: no callerPhone supplied for an established company', { targetCompanyID });
            return {
              result: { status: 'caller_phone_required', created: false },
              message:
                'Not created. This account already exists, so adding someone to it needs ' +
                'the number the caller is dialling from. Call again with callerPhone set ' +
                'to the caller ID for this conversation.',
            };
          }

          let tiedHere = false;
          try {
            // Already on file at this company under this number: a second
            // person on a shared line, or a record being re-made.
            const tied = await s.searchContacts({ phone: callerPhone, isActive: 1, pageSize: 200 } as any);
            tiedHere = tied.some((c: any) => c.companyID === targetCompanyID);
            if (!tiedHere) {
              // Or dialling in on the company's own main line.
              const co: any = await s.getCompany(targetCompanyID);
              tiedHere = isExactPhoneMatch(callerPhone, co?.phone);
            }
          } catch (err) {
            this.logger.error('Access gate lookup failed; refusing', { err, targetCompanyID });
            return {
              result: { status: 'gate_unavailable', created: false },
              message:
                'Not created. The account could not be checked just now, so a contact ' +
                'cannot be added to it. Open the ticket for the company without a contact ' +
                'and record who called; a technician will attach them.',
            };
          }

          if (!tiedHere) {
            this.logger.warn('Access gate: caller number is not associated with the target account', {
              targetCompanyID,
            });
            return {
              result: { status: 'not_tied_to_company', created: false },
              message:
                'Not created. The number this caller is dialling from is not associated ' +
                'with that account, so they cannot be added to it from a call. Open the ' +
                'ticket for the company with no contact attached and record who called ' +
                'and what they need; a technician will verify them and attach the contact.',
            };
          }
        }

        // ══ DUPLICATE CHECK ═══════════════════════════════════════════════
        // Only reached once the gate has passed, so any match here is at an
        // account this caller is already tied to. The name the caller gave is
        // matched against whoever holds the address, using the same matcher the
        // lock step uses — so Ivy is never handed a fact she did not already
        // have and never has to ask anything.
        const emailIn = String(a.emailAddress ?? '').trim();
        const isIdentityEmail =
          emailIn.length > 0 &&
          !PLACEHOLDER_EMAILS.has(emailIn.toLowerCase()) &&
          EMAIL_SHAPE.test(emailIn);

        if (isIdentityEmail) {
          let holders: any[] = [];
          try {
            holders = await s.findActiveContactsByEmail(emailIn);
          } catch (err) {
            this.logger.warn('Duplicate-email check errored; creating without it', { err });
            holders = [];
          }
          if (holders.length > 0) {
            const verdict = matchSpokenName(holders as any, a.firstName ?? null, a.lastName ?? null);
            // One holder whose name is close but not conclusive is still that
            // person: an exact email plus a near name is not coincidence.
            // Unrelated names come back new_contact — the shared-mailbox case
            // (staff@williamsobgyn.com is three people at one company).
            const sibling =
              verdict.status === 'locked' ? (verdict as any).contact
              : (verdict.status === 'candidates' && holders.length === 1) ? holders[0]
              : null;
            if (sibling && sibling.companyID === targetCompanyID) {
              this.logger.info('create_contact suppressed: already on file at this company', {
                existing: sibling.id, targetCompanyID,
              });
              return {
                result: { status: 'existing_contact', created: false, contactID: sibling.id },
                message:
                  `Not created. This person is already on file at this company as contact ` +
                  `${sibling.id}. Use that contactID.`,
              };
            }
          }
        }

        // callerPhone: consumed by the gate above, AND persisted onto the record
        // (S1, 2026-08-15). The point of auto-adding a contact is that the next
        // call from this number matches; 4 of the 10 contacts Ivy created before
        // this fix carried no phone on any field and could never match again.
        // The model has sent the literal variable NAME here ("system__caller_id",
        // observed live 2026-08-16) — a wrong value that then fails the tied-to-
        // account check with a false "not associated" answer. A phone is digits.
        const callerPhoneRaw = String(a.callerPhone ?? '').trim();
        if (callerPhoneRaw && String(callerPhoneRaw).replace(/\D/g, '').length < 7) {
          return {
            result: { status: 'caller_phone_invalid', created: false },
            message:
              'Not created. callerPhone must be the actual number the caller is ' +
              'dialling from, as digits. It is supplied automatically on this ' +
              'agent; call again without inventing a value.',
          };
        }
        const callerPhoneIn = callerPhoneRaw;
        delete a.callerPhone;
        if (callerPhoneIn && !String(a.phone ?? '').trim() && !String(a.mobilePhone ?? '').trim()) {
          a.phone = callerPhoneIn;
        }

        // No email provided: opt the contact out of email workflows so the record
        // matches what the Autotask UI requires for emailless contacts (the UI
        // enforces email OR the four opt-outs; the REST API enforces neither).
        if (!a.emailAddress) {
          a.solicitationOptOut = true;
          a.surveyOptOut = true;
          a.isOptedOutFromBulkEmail = true;
          a.receivesEmailNotifications = false;
        }
        const id = await s.createContact(a);
        // ── B15 (2026-08-17, Brian): company web domain from the contact's email ─
        // The web field maps inbound emailers to the account. One spelled email
        // yields two facts: the contact's address and, when the domain is not a
        // free-mail provider, the company's domain. Written ONLY when the
        // company's webAddress is empty (never overwrites) and never for
        // residential accounts (classification 13). Best-effort: any failure
        // here must not disturb the contact create that already succeeded.
        try {
          const dom = String(a.emailAddress ?? '').split('@')[1]?.trim().toLowerCase();
          if (dom && !FREEMAIL_DOMAINS.has(dom) && a.companyID != null) {
            const co: any = await s.getCompany(Number(a.companyID));
            const web = String(co?.webAddress ?? '').trim();
            if (co && !web && Number(co.classification) !== 13) {
              await s.updateCompany(Number(a.companyID), { webAddress: dom } as any);
              this.logger.info('B15: company webAddress set from contact email domain', { companyID: a.companyID, domain: dom });
            }
          }
        } catch { /* domain mapping is a bonus, never a blocker */ }
        // B18 (2026-08-17): the email ask lives in the KB but production test 1
        // showed it being skipped at the moment of creation. Say it at the moment
        // of decision, the channel that provably reaches her. A decline is fine
        // and needs no retry; this fires only when no email arrived at all.
        const emailNudge = a.emailAddress
          ? ''
          : ' Created without an email address. If the caller has not been asked yet, offer once to take their email; a decline is fine and the record stands.';
        const outcome = { result: id, message: `Successfully created contact with ID: ${id}.${emailNudge}` };
        RECENT_CREATES.record(replayKey, outcome);
        return outcome;
      }],

      // Tickets
      ['autotask_search_tickets', async (a) => {
        // Elicitation for zero-filter ticket searches
      const hasFilters = a.searchTerm || a.contactID || a.companyID || a.status !== undefined ||
        a.assignedResourceID || a.unassigned ||
        a.createdAfter || a.createdBefore || a.lastActivityAfter;
        if (!hasFilters && this.mcpServer) {
          const dateChoice = await this.elicitDateRange();
          if (dateChoice) a = { ...a, ...dateChoice };
        }
        const { companyID, contactID, ...rest } = a;
        const opts = {
          ...rest,
          ...(companyID !== undefined && { companyId: companyID }),
          ...(contactID !== undefined && { contactID }),
        };
        // Report the page size the query ACTUALLY used, not the one the caller
        // supplied (usually nothing). See resolveTicketQuery.
        const effectivePageSize = resolveTicketQuery(opts).pageSize;
        const r = await s.searchTickets(opts);

        // An empty scoped result is ambiguous, and the two cases are not the
        // same fact: either this company/contact has no tickets in the window,
        // or the id never identified a record at all. Autotask /query returns an
        // empty set for a filter on a non-existent id, so passing that through
        // as "0 tickets" asserts something about the world that was never
        // established. Same defect class as lookup_tech_status conflating
        // no-match with unavailable (7cd6222): report a fact about the RESULT
        // and let the consumer decide. Costs one extra read, on the miss path
        // only.
        //
        // Observed 2026-07-27: 7 of 12 ticket searches passed a contactID in the
        // companyID slot (caller_context supplied no companyID on the
        // ambiguous_multi_company branch). All returned 0. On conv_...3kmpgy1bdp
        // the caller was told "I don't see any open tickets for Consolidated
        // Services" three times; she had three, and the real companyID was 822.
        // getCompany/getContact throw on a 404 instead of returning null, so a
        // bare falsy check never fires — the throw escapes to the generic tool
        // error handler and the actionable message is lost. Classify: only a
        // genuine not-found means the id is bogus. Any other failure rethrows,
        // so an Autotask outage never gets reported as "no such company".
        const idExists = async (kind: 'company' | 'contact', id: number): Promise<boolean> => {
          try {
            const rec = kind === 'company' ? await s.getCompany(id) : await s.getContact(id);
            return !!rec;
          } catch (err) {
            if (isNotFoundError(err)) return false;
            throw err;
          }
        };

        if (r.length === 0) {
          if (companyID !== undefined) {
            if (!(await idExists('company', Number(companyID)))) {
              return {
                result: { status: 'unknown_company', companyID },
                message: `No company exists with id ${companyID}, so this search established nothing about their tickets. Do not tell the caller they have no tickets. If this id came from caller context it is a contactID, not a companyID — retry with contactID: ${companyID}.`,
              };
            }
          }
          if (contactID !== undefined) {
            if (!(await idExists('contact', Number(contactID)))) {
              return {
                result: { status: 'unknown_contact', contactID },
                message: `No contact exists with id ${contactID}, so this search established nothing about their tickets. Do not tell the caller they have no tickets.`,
              };
            }
          }
        }
        return { result: r, message: `Found ${r.length} tickets`, effectivePageSize };
      }],
      ['autotask_get_ticket_details', async (a) => {
        const r = await s.getTicket(a.ticketID, a.fullDetails); return { result: r, message: 'Ticket details retrieved successfully' };
      }],
      ['autotask_create_ticket', async (a) => {
        const id = await s.createTicket(a);
        // Fetch the created ticket to get the ticket number for the caller
        let ticketNumber: string | undefined;
        try {
          const ticket = await s.getTicket(id);
          ticketNumber = ticket?.ticketNumber;
        } catch { /* non-critical */ }
        const display = ticketNumber ? `${ticketNumber} (ID: ${id})` : `${id}`;
        // ticketID at the top level of the result: ElevenLabs response assignments
        // read tool responses by path, and this is what writes the locked_ticket_id
        // dynamic variable that /call-closure prefers over transcript extraction.
        return { result: { id, ticketNumber, ticketID: id }, message: `Successfully created ticket ${display}` };
      }],
      ['autotask_update_ticket', async (a) => {
        const { ticketId, ...updates } = a;
        await s.updateTicket(ticketId, updates);
        return { result: ticketId, message: `Successfully updated ticket ${ticketId}` };
      }],

      // Time entries
      ['autotask_create_time_entry', async (a) => {
        const id = await s.createTimeEntry(a); return { result: id, message: `Successfully created time entry with ID: ${id}` };
      }],

      // Projects
      ['autotask_search_projects', async (a) => {
        const r = await s.searchProjects(a); return { result: r, message: `Found ${r.length} projects` };
      }],
      ['autotask_create_project', async (a) => {
        const id = await s.createProject(a); return { result: id, message: `Successfully created project with ID: ${id}` };
      }],

      ['autotask_check_date_hours', async (a) => {
        const r = await s.checkDateHours(String(a.date || ''));
        return { result: r, message: `Business status for ${r.date}: ${r.status}` };
      }],

      // Resources
      ['autotask_search_resources', async (a) => {
        // S3 (2026-08-15): an empty searchTerm returns the entire staff roster.
        // Measured: 41 empty-searchTerm calls across 1,765 conversations, the
        // cornered pattern behind the 08-03 owner call (25 staff records pulled
        // into context, the CEO named to an unknown caller). A specific name or
        // extension is the only legitimate ask here.
        if (!a.searchTerm || typeof a.searchTerm !== 'string' || a.searchTerm.trim() === '') {
          return {
            result: { status: 'search_term_required' },
            message:
              'searchTerm is required: a specific person\'s name or extension. ' +
              'For role-level requests (owner, manager), take a message instead ' +
              'of searching the roster.',
          };
        }
        const r = await s.searchResources(a);
        // Zero on a multi-word term is usually a person being looked for by
        // full name in the wrong tool (2026-08-20). Affirmative pointer only.
        const msg = (r.length === 0 && String(a.searchTerm).trim().split(/\s+/).length >= 2)
          ? `Found 0 resources. To reach a team member by name, use autotask_lookup_tech_status — it matches spoken names and reports availability.`
          : `Found ${r.length} resources`;
        return { result: r, message: msg };
      }],
      ['autotask_lookup_tech_status', async (a) => {
        const searchTerm = a.searchTerm;
        if (!searchTerm || typeof searchTerm !== 'string' || searchTerm.trim() === '') {
          return {
            result: { status: 'no_match', reason: 'empty_searchTerm' },
            message: 'searchTerm is required'
          };
        }

        // Step 1: build the phone-routable tech roster: active resources with an
        // office extension. API and service accounts never have extensions, so
        // this filter excludes them without relying on name or title heuristics.
        const allActive = await s.searchResources({ isActive: true, pageSize: 100 });
        const roster = allActive.filter((t: any) => t.officeExtension && String(t.officeExtension).trim() !== '');

        // Match the spoken name against the roster: exact first, then small
        // edit-distance fuzzy. STT regularly mangles names (e.g. "Reina" for
        // "Reyna"); fuzzy matching a ~10 person roster with unique first names
        // is safe. Threshold: 1 edit for short names, 2 for longer.
        const norm = (x: any) => String(x || '').toLowerCase().replace(/[^a-z]/g, '');
        const term = norm(searchTerm);
        const editDistance = (a: string, b: string): number => {
          const dp: number[][] = Array.from({ length: a.length + 1 }, (_, r) => {
            const row = new Array(b.length + 1).fill(0); row[0] = r; return row;
          });
          for (let c = 1; c <= b.length; c++) dp[0][c] = c;
          for (let r = 1; r <= a.length; r++)
            for (let c = 1; c <= b.length; c++)
              dp[r][c] = Math.min(dp[r-1][c] + 1, dp[r][c-1] + 1, dp[r-1][c-1] + (a[r-1] === b[c-1] ? 0 : 1));
          return dp[a.length][b.length];
        };
        const nameFields = (t: any): string[] =>
          [t.firstName, t.lastName, `${t.firstName || ''}${t.lastName || ''}`].map(norm).filter(Boolean);
        const distanceTo = (t: any): number => Math.min(...nameFields(t).map(f => editDistance(term, f)));

        let matchedFuzzy = false;
        let matches = roster.filter((t: any) => nameFields(t).includes(term));
        if (matches.length === 0 && term.length >= 3) {
          const maxDist = term.length <= 4 ? 1 : 2;
          const scored = roster
            .map((t: any) => ({ t, d: distanceTo(t) }))
            .filter((x: any) => x.d <= maxDist)
            .sort((x: any, y: any) => x.d - y.d);
          if (scored.length === 1 || (scored.length > 1 && scored[0].d < scored[1].d)) {
            matches = [scored[0].t];
            matchedFuzzy = true;
          } else if (scored.length > 1) {
            return { result: { status: 'ambiguous', count: scored.length }, message: `${scored.length} close matches \u2014 need more info` };
          }
        }

        if (matches.length === 0) {
          // Affirmative-only (CVIT best practice, Brian 2026-08-17): no roster
          // claims in either direction -- departed staff stay undisclosed and
          // a matcher miss on a current tech never becomes a spoken denial.
          return { result: {
            status: 'no_match', searchTerm: searchTerm.trim(),
            guidance: 'Say: "Let me connect you with the team that can help, and they can route you from there." Route by the caller\'s need, or offer to take a message.',
          }, message: `No tech matched "${searchTerm.trim()}"` };
        }
        if (matches.length > 1) {
          return { result: {
            status: 'ambiguous', count: matches.length,
            guidance: 'More than one team member matches. Ask for their full name or which team they are on, then search again.',
          }, message: `${matches.length} matches — need more info` };
        }

        // Single match
        const tech = matches[0];
        const name = `${tech.firstName || ''} ${tech.lastName || ''}`.trim() || 'Unknown';
        const title = tech.title || null;
        const ext = tech.officeExtension ? String(tech.officeExtension) : '';

        if (!ext) {
          return { result: { status: 'no_extension', name, title }, message: 'Tech found but not phone-routable' };
        }

        // Who-is-who bundle (2026-08-18, Brian): the response carries the
        // CANONICAL roster name, the verified extension, and the line to say,
        // so nothing downstream is re-derived from what was heard. matchedFuzzy
        // adds a confirm-first step -- she confirms with the ROSTER spelling.
        // Business hours ride along so an after-hours transfer offer is never
        // generated (offer-then-retract, Brian's 08-17 19:16 test). Fail-open:
        // an unknown business status behaves exactly like today.
        const confirmFirst = matchedFuzzy
          ? `Confirm first: "You're looking to reach ${name}, correct?" Then `
          : '';
        let bizClosed = false; let nextOpen = '';
        try {
          const biz = await s.getBusinessStatus();
          bizClosed = Boolean(biz && biz.business_status && biz.business_status !== 'open');
          nextOpen = (biz && biz.next_open_text) || '';
        } catch { bizClosed = false; }
        if (bizClosed) {
          return { result: {
            status: 'after_hours', name, title, officeExtension: ext,
            matched: matchedFuzzy ? 'fuzzy' : 'exact',
            next_open_text: nextOpen || null,
            guidance: `The office is closed, so a transfer to ${name} will not connect. ` +
              `${confirmFirst}offer: "${name} is gone for the day — I can add a note so they follow up ` +
              `when we reopen${nextOpen ? ' ' + nextOpen : ''}, or if this is an emergency I can reach our on-call support."`,
          }, message: `Office closed — ${name} not reachable until ${nextOpen || 'next open'}` };
        }

        // Step 2: presence-service
        const presenceUrl = process.env.PRESENCE_SERVICE_URL || 'https://presence-service-production-daeb.up.railway.app';
        const presenceToken = process.env.PRESENCE_SERVICE_TOKEN;

        if (!presenceToken) {
          return {
            result: { status: 'presence_unavailable', name, title, officeExtension: ext, reason: 'token_missing' },
            message: 'Presence token not configured'
          };
        }

        try {
          const r = await fetch(`${presenceUrl}/tech/${encodeURIComponent(ext)}/availability`, {
            headers: { 'Authorization': presenceToken },
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) {
            return {
              result: { status: 'presence_unavailable', name, title, officeExtension: ext, reason: `presence_http_${r.status}` },
              message: `Presence check returned ${r.status}`
            };
          }
          const data: any = await r.json();
          const isAvailable = data.available === true;
          return {
            result: {
              status: isAvailable ? 'available' : 'not_available', name, title, officeExtension: ext, available: isAvailable,
              matched: matchedFuzzy ? 'fuzzy' : 'exact',
              guidance: isAvailable
                ? `${confirmFirst}say: "Connecting you to ${name} now." Use resolve_transfer_extension with extension ${ext} and transfer.`
                : `${confirmFirst}offer: "${name} isn't available right now — I can add a note to your ticket, take a message, or connect you with the support queue."`,
            },
            message: `Tech ${name} is ${isAvailable ? 'available' : 'not available'}`
          };
        } catch (err) {
          return {
            result: { status: 'presence_unavailable', name, title, officeExtension: ext, reason: 'presence_network_error' },
            message: 'Presence service unreachable'
          };
        }
      }],

      // Configuration Items
      ['autotask_search_configuration_items', async (a) => {
        const r = await s.searchConfigurationItems(a); return { result: r, message: `Found ${r.length} configuration items` };
      }],

      // Contracts
      ['autotask_search_contracts', async (a) => {
        const r = await s.searchContracts(a); return { result: r, message: `Found ${r.length} contracts` };
      }],

      // Invoices
      ['autotask_search_invoices', async (a) => {
        const r = await s.searchInvoices(a); return { result: r, message: `Found ${r.length} invoices` };
      }],

      // Tasks
      ['autotask_search_tasks', async (a) => {
        const r = await s.searchTasks(a); return { result: r, message: `Found ${r.length} tasks` };
      }],
      ['autotask_create_task', async (a) => {
        const id = await s.createTask(a); return { result: id, message: `Successfully created task with ID: ${id}` };
      }],

      // Notes (ticket/project/company)
      ['autotask_get_ticket_note', async (a) => {
        const r = await s.getTicketNote(a.ticketId, a.noteId); return { result: r, message: 'Ticket note retrieved successfully' };
      }],
      ['autotask_search_ticket_notes', async (a) => {
        const r = await s.searchTicketNotes(a.ticketId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} ticket notes` };
      }],
      ['autotask_create_ticket_note', async (a) => {
        const id = await s.createTicketNote(a.ticketId, { title: a.title, description: a.description, noteType: a.noteType, publish: a.publish });

        // A caller-visible note (publish=1) advances the ticket to "Customer Noted"
        // automatically. The KB has instructed the agent to do this as a second
        // autotask_update_ticket call since v213, and it does not happen: measured
        // 2026-07-26 over 191 calls, 28 notes were written and only 2 were followed by
        // an update (7%). The step has no in-call payoff and competes with a pending
        // transfer, so more prompt text will not fix it. Doing it here makes it
        // unconditional.
        //
        // Deliberately NOT done for publish=2 (internal notes, including the
        // /call-closure report) — those are not customer communication.
        //
        // Best-effort: a failure here must never fail the note. The note is the
        // durable record; the status is bookkeeping. Autotask has returned HTTP 500
        // on PATCH for tickets under edit lock (observed 2026-07-20 on ticket 57186).
        let statusMsg = '';
        if (a.publish === 1) {
          try {
            const current = await s.getTicket(a.ticketId);
            const currentStatus = current?.status;
            const statuses = await this.picklistCache.getTicketStatuses();
            const cn = statuses.find(x => String(x.label).toLowerCase() === 'customer noted');
            const customerNotedId = cn ? parseInt(String(cn.value), 10) : null;
            const comp = statuses.find(x => String(x.label).toLowerCase() === 'complete');
            const completeId = comp ? parseInt(String(comp.value), 10) : null;

            // Complete was excluded from the allowlist above on the reasoning that
            // "reopening is a deliberate act, not a side effect", assuming the KB's
            // 7-day rule had her reopen via autotask_update_ticket first. She does that
            // on 7% of notes (measured 2026-07-26, 28 notes, 2 follow-ups). So the note
            // lands on a ticket nobody watches and the caller's request is lost:
            //   2026-07-31  Linda Pulido, T20260623.0036, closed 38 days. She drove to
            //               the shop on 08-03 because nobody called back.
            //   2026-08-05  Jerry Orlanes, 57425, closed 12 days, a callback request.
            // Brian 2026-08-05: reopen it. This reverses the 2026-07-26 decision.
            //
            // RMM Complete (20) stays excluded: closed by automation, not ours to reopen.
            //
            // Status is read here, at note time, deliberately. A ticket can close during
            // the call: 57985 was noted at 11:14 and completed at 11:24, so it was open
            // when she wrote and nothing should fire. Comparing calendar dates instead of
            // the live status would have wrongly treated that as a note on closed work.
            const wasComplete = completeId != null && currentStatus === completeId;

            if (customerNotedId != null &&
                (CUSTOMER_NOTED_SOURCE_STATUSES.has(currentStatus as number) || wasComplete)) {
              await s.updateTicket(a.ticketId, { status: customerNotedId });
              if (wasComplete) {
                statusMsg = ' This ticket was Complete; it has been reopened to Customer Noted.';
                const done = (current as any)?.completedDate;
                const days = done ? Math.floor((Date.now() - new Date(done).getTime()) / 86400000) : null;
                if (days != null && days > 7) {
                  statusMsg += ` It had been closed ${days} days. If this is a new issue rather than a continuation, open a new ticket and reference this one.`;
                }
              } else {
                statusMsg = ' Ticket status set to Customer Noted.';
              }
            }
          } catch (noteStatusErr) {
            this.logger.warn('Ticket note saved but status update to Customer Noted failed', {
              ticketId: a.ticketId,
              err: (noteStatusErr as Error)?.message,
            });
          }
        }
        // ticketID echoed for the same reason as on create_ticket: a note binds the
        // call to this ticket, and the assignment writes locked_ticket_id from it.
        return { result: { noteId: id, ticketID: a.ticketId }, message: `Successfully created ticket note with ID: ${id}.${statusMsg}` };
      }],
      ['autotask_get_project_note', async (a) => {
        const r = await s.getProjectNote(a.projectId, a.noteId); return { result: r, message: 'Project note retrieved successfully' };
      }],
      ['autotask_search_project_notes', async (a) => {
        const r = await s.searchProjectNotes(a.projectId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} project notes` };
      }],
      ['autotask_create_project_note', async (a) => {
        const id = await s.createProjectNote(a.projectId, { title: a.title, description: a.description, noteType: a.noteType });
        return { result: id, message: `Successfully created project note with ID: ${id}` };
      }],
      ['autotask_get_company_note', async (a) => {
        const r = await s.getCompanyNote(a.companyId, a.noteId); return { result: r, message: 'Company note retrieved successfully' };
      }],
      ['autotask_search_company_notes', async (a) => {
        const r = await s.searchCompanyNotes(a.companyId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} company notes` };
      }],
      ['autotask_create_company_note', async (a) => {
        const id = await s.createCompanyNote(a.companyId, { title: a.title, description: a.description, actionType: a.actionType });
        return { result: id, message: `Successfully created company note with ID: ${id}` };
      }],

      // Attachments
      ['autotask_get_ticket_attachment', async (a) => {
        const r = await s.getTicketAttachment(a.ticketId, a.attachmentId, a.includeData); return { result: r, message: 'Ticket attachment retrieved successfully' };
      }],
      ['autotask_search_ticket_attachments', async (a) => {
        const r = await s.searchTicketAttachments(a.ticketId, { pageSize: a.pageSize }); return { result: r, message: `Found ${r.length} ticket attachments` };
      }],

      // Expense Reports
      ['autotask_get_expense_report', async (a) => {
        const r = await s.getExpenseReport(a.reportId); return { result: r, message: 'Expense report retrieved successfully' };
      }],
      ['autotask_search_expense_reports', async (a) => {
        const r = await s.searchExpenseReports({ submitterId: a.submitterId, status: a.status, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} expense reports` };
      }],
      ['autotask_create_expense_report', async (a) => {
        const id = await s.createExpenseReport({ name: a.name, description: a.description, submitterID: a.submitterID, weekEndingDate: a.weekEndingDate });
        return { result: id, message: `Successfully created expense report with ID: ${id}` };
      }],

      // Expense Items
      ['autotask_create_expense_item', async (a) => {
        const id = await s.createExpenseItem({ expenseReportID: a.expenseReportId, description: a.description, expenseDate: a.expenseDate, expenseCategory: a.expenseCategory, expenseCurrencyExpenseAmount: a.amount, companyID: a.companyId ?? 0, haveReceipt: a.haveReceipt ?? false, isBillableToCompany: a.isBillableToCompany ?? false, isReimbursable: a.isReimbursable ?? true, paymentType: a.paymentType ?? 10 });
        return { result: id, message: `Successfully created expense item with ID: ${id}` };
      }],

      // Quotes
      ['autotask_get_quote', async (a) => {
        const r = await s.getQuote(a.quoteId); return { result: r, message: 'Quote retrieved successfully' };
      }],
      ['autotask_search_quotes', async (a) => {
        const r = await s.searchQuotes({ companyId: a.companyId, contactId: a.contactId, opportunityId: a.opportunityId, searchTerm: a.searchTerm, pageSize: a.pageSize });
        return { result: r, message: `Found ${r.length} quotes` };
      }],
      ['autotask_create_quote', async (a) => {
        const id = await s.createQuote({ name: a.name, description: a.description, companyID: a.companyId, contactID: a.contactId, opportunityID: a.opportunityId, effectiveDate: a.effectiveDate, expirationDate: a.expirationDate });
        return { result: id, message: `Successfully created quote with ID: ${id}` };
      }],

      // Picklist tools
      ['autotask_list_queues', async () => {
        const queues = await this.picklistCache.getQueues();
        return { result: queues.map(q => ({ id: q.value, name: q.label, isActive: q.isActive })), message: `Found ${queues.length} queues` };
      }],
      ['autotask_list_ticket_statuses', async () => {
        const statuses = await this.picklistCache.getTicketStatuses();
        return { result: statuses.map(s => ({ id: s.value, name: s.label, isActive: s.isActive })), message: `Found ${statuses.length} ticket statuses` };
      }],
      ['autotask_list_ticket_priorities', async () => {
        const priorities = await this.picklistCache.getTicketPriorities();
        return { result: priorities.map(p => ({ id: p.value, name: p.label, isActive: p.isActive })), message: `Found ${priorities.length} ticket priorities` };
      }],
      ['autotask_list_company_categories', async (a) => {
        const cats = await s.listCompanyCategories({ activeOnly: !!a.activeOnly });
        return { result: cats, message: `Found ${cats.length} company categories` };
      }],
      ['autotask_get_field_info', async (a) => {
        const fields = await this.picklistCache.getFields(a.entityType);
        if (a.fieldName) {
          const field = fields.find(f => f.name.toLowerCase() === a.fieldName.toLowerCase());
          return { result: field || null, message: field ? `Field info for ${a.entityType}.${a.fieldName}` : `Field '${a.fieldName}' not found on ${a.entityType}` };
        }
        const summary = fields.map(f => ({ name: f.name, dataType: f.dataType, isRequired: f.isRequired, isPickList: f.isPickList, isQueryable: f.isQueryable, picklistValueCount: f.picklistValues?.length || 0 }));
        return { result: summary, message: `Found ${fields.length} fields for ${a.entityType}` };
      }],

      // Billing Items (Approve and Post workflow)
      ['autotask_search_billing_items', async (a) => {
        const r = await s.searchBillingItems({
          companyId: a.companyId,
          ticketId: a.ticketId,
          projectId: a.projectId,
          contractId: a.contractId,
          invoiceId: a.invoiceId,
          postedAfter: a.postedAfter,
          postedBefore: a.postedBefore,
          page: a.page,
          pageSize: a.pageSize
        } as any);
        return { result: r, message: `Found ${r.length} billing items` };
      }],
      ['autotask_get_billing_item', async (a) => {
        const r = await s.getBillingItem(a.billingItemId);
        return { result: r, message: 'Billing item retrieved successfully' };
      }],

      // Billing Item Approval Levels
      ['autotask_search_billing_item_approval_levels', async (a) => {
        const r = await s.searchBillingItemApprovalLevels({
          timeEntryId: a.timeEntryId,
          approvalResourceId: a.approvalResourceId,
          approvalLevel: a.approvalLevel,
          approvedAfter: a.approvedAfter,
          approvedBefore: a.approvedBefore,
          page: a.page,
          pageSize: a.pageSize
        } as any);
        return { result: r, message: `Found ${r.length} billing item approval levels` };
      }],

      // Time Entries
      ['autotask_search_time_entries', async (a) => {
        const r = await s.searchTimeEntries({
          resourceId: a.resourceId,
          ticketId: a.ticketId,
          projectId: a.projectId,
          taskId: a.taskId,
          approvalStatus: a.approvalStatus,
          billable: a.billable,
          dateWorkedAfter: a.dateWorkedAfter,
          dateWorkedBefore: a.dateWorkedBefore,
          page: a.page,
          pageSize: a.pageSize
        } as any);
        return { result: r, message: `Found ${r.length} time entries` };
      }],
    ]);
  }

  /**
   * Call a tool with the given arguments
   */
  async callTool(name: string, args: Record<string, any>): Promise<McpToolResult> {
    this.logger.debug(`Calling tool: ${name}`, args);

    try {
      const handler = this.getDispatchTable().get(name);
      if (!handler) throw new Error(`Unknown tool: ${name}`);

      const { result, message, hint, effectivePageSize } = await handler(args);

      // Skip name resolution for tools where it would cause unnecessary API calls
      // without providing value. Contact tools return IDs that Ivy uses directly.
      const skipEnhancement = SKIP_ENHANCEMENT_TOOLS.has(name);

      // Format and enhance response
      let responseText: string;
    let topLevelData: any;
      if (COMPACT_SEARCH_TOOLS.has(name) && Array.isArray(result)) {
        const entityType = detectEntityType(name);
        if (entityType) {
          const compact = await formatCompactResponse(result, entityType, {
            page: args.page,
            // effectivePageSize is what the query ran at; args.pageSize is only
            // what the caller asked for. hasMore is derived from this, so using
            // the request value made a complete result set claim more existed.
            pageSize: effectivePageSize ?? args.pageSize,
            ...(hint !== undefined && { hint }),
          }, (entity, field) => this.picklistCache.getPicklistValues(entity, field));
          if (!skipEnhancement) {
            compact.items = await this.enhanceItems(compact.items);
          }
          responseText = JSON.stringify(compact);
        } else {
          const items = skipEnhancement ? result : await this.enhanceItems(result);
          responseText = JSON.stringify({ message, data: items });
        }
      } else if (Array.isArray(result)) {
        const items = skipEnhancement ? result : await this.enhanceItems(result);
        responseText = JSON.stringify({ message, data: items });
      } else if (result && typeof result === 'object' && !Array.isArray(result)) {
        const enhanced = skipEnhancement ? [result] : await this.enhanceItems([result]);
        topLevelData = enhanced[0] || result;
      responseText = JSON.stringify({ message, data: topLevelData });
      } else {
        responseText = JSON.stringify({ message, data: result });
      }

      this.logger.debug(`Successfully executed tool: ${name}`);
      return { content: [{ type: 'text', text: responseText }], ...(topLevelData !== undefined ? { data: topLevelData } : {}) };

    } catch (error) {
      this.logger.error(`Tool execution failed for ${name}:`, error);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error', tool: name }) }],
        isError: true
      };
    }
  }
}
