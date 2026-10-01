/**
 * Ticket queue routing (2026-09-30).
 *
 * 220 of 220 Ivy-created tickets in 08-30..09-29 carried no queueID, so every
 * one landed in the category default and dispatch re-queued residential work
 * into Shop by hand. The rule they applied is the account's classification.
 * The server now applies it at create; the agent never decides a queue.
 */
jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mocked - not used')) },
}));

import { queueForTicket, QUEUE_SHOP, QUEUE_LEADS, QUEUE_SUPPORT_1, CLASSIFICATION_RESIDENTIAL } from '../src/utils/ticket-queue';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';

describe('queueForTicket: the rule, from the account', () => {
  test('residential account (classification 13) -> Shop', () => {
    expect(queueForTicket(5922, CLASSIFICATION_RESIDENTIAL)).toBe(QUEUE_SHOP);
  });
  test('unverified caller (catch-all company 0) -> Leads, whatever classification is claimed', () => {
    expect(queueForTicket(0, null)).toBe(QUEUE_LEADS);
    expect(queueForTicket(0, CLASSIFICATION_RESIDENTIAL)).toBe(QUEUE_LEADS);
    expect(queueForTicket(undefined, null)).toBe(QUEUE_LEADS);
  });
  test.each([
    ['Silver Managed Service', 17],
    ['Gold Managed Service', 15],
    ['T&M', 12],
    ['Vendor', 200],
  ])('business account (%s, classification %i) -> Support 1', (_label, classification) => {
    expect(queueForTicket(840, classification)).toBe(QUEUE_SUPPORT_1);
  });
  test('company readable but classification unset -> Support 1, where a human looks first', () => {
    expect(queueForTicket(840, null)).toBe(QUEUE_SUPPORT_1);
    expect(queueForTicket(840, undefined)).toBe(QUEUE_SUPPORT_1);
  });
  test('the three ids are the tenant\'s picklist values (at_list_ticket_queues, 2026-09-29)', () => {
    expect(QUEUE_SHOP).toBe(29683484);
    expect(QUEUE_LEADS).toBe(29683483);
    expect(QUEUE_SUPPORT_1).toBe(29682833);
  });
});

function makeHandler(companies: Record<number, any>, opts: { companyThrows?: boolean } = {}) {
  const created: any[] = [];
  const service: any = {
    async createTicket(t: any) { created.push(t); return 60999; },
    async getTicket(id: number) { return { id, ticketNumber: 'T20260930.0001' }; },
    async getCompany(id: number) {
      if (opts.companyThrows) throw new Error('Autotask 500');
      return companies[id] ?? null;
    },
    testConnection: async () => true,
  };
  const handler = new AutotaskToolHandler(service, { info(){}, warn(){}, error(){}, debug(){} } as any);
  return { handler, created };
}

const base = { title: 'Laptop will not boot', description: 'x', status: 1, priority: 2 };

describe('autotask_create_ticket sets queueID from the account', () => {
  test('residential company -> Shop', async () => {
    const { handler, created } = makeHandler({ 5922: { id: 5922, classification: 13 } });
    await handler.callTool('autotask_create_ticket', { ...base, companyID: 5922 });
    expect(created[0].queueID).toBe(QUEUE_SHOP);
  });
  test('managed business -> Support 1', async () => {
    const { handler, created } = makeHandler({ 840: { id: 840, classification: 17 } });
    await handler.callTool('autotask_create_ticket', { ...base, companyID: 840 });
    expect(created[0].queueID).toBe(QUEUE_SUPPORT_1);
  });
  test('catch-all company 0 -> Leads, and the company is never read', async () => {
    let reads = 0;
    const { handler, created } = makeHandler(new Proxy({}, { get() { reads++; return undefined; } }));
    await handler.callTool('autotask_create_ticket', { ...base, companyID: 0 });
    expect(created[0].queueID).toBe(QUEUE_LEADS);
    expect(reads).toBe(0);
  });
  test('a queueID the agent passes is replaced by the rule', async () => {
    const { handler, created } = makeHandler({ 5922: { id: 5922, classification: 13 } });
    await handler.callTool('autotask_create_ticket', { ...base, companyID: 5922, queueID: QUEUE_SUPPORT_1 });
    expect(created[0].queueID).toBe(QUEUE_SHOP);
  });
  test('company read fails -> ticket still created, in Support 1', async () => {
    const { handler, created } = makeHandler({}, { companyThrows: true });
    const r: any = await handler.callTool('autotask_create_ticket', { ...base, companyID: 840 });
    expect(created).toHaveLength(1);
    expect(created[0].queueID).toBe(QUEUE_SUPPORT_1);
    expect(r.content.map((c: any) => c.text).join('')).toMatch(/T20260930\.0001/);
  });
  test('the tool tells the agent the queue is not hers to pass', () => {
    const def = TOOL_DEFINITIONS.find((d: any) => d.name === 'autotask_create_ticket') as any;
    expect(def.description).toMatch(/never pass queueID/);
    expect(def.inputSchema.properties.queueID).toBeUndefined();
  });
});

describe('autotask_create_company customer_type "vendor" (2026-09-30)', () => {
  test('writes companyType 7 and classification 200', async () => {
    const created: any[] = [];
    const service: any = {
      async createCompany(c: any) { created.push(c); return 7756; },
      async searchCompanies() { return []; },
      async getCompany() { return null; },
      testConnection: async () => true,
    };
    const handler = new AutotaskToolHandler(service, { info(){}, warn(){}, error(){}, debug(){} } as any);
    const r: any = await handler.callTool('autotask_create_company', { companyName: 'Golden Plus', customer_type: 'vendor', phone: '840-207-8917' });
    const text = r.content.map((c: any) => c.text).join('');
    expect(text).not.toMatch(/error/i);
    expect(created).toHaveLength(1);
    expect(created[0].companyType).toBe(7);
    expect(created[0].classification).toBe(200);
  });
  test('the enum offers it', () => {
    const def = TOOL_DEFINITIONS.find((d: any) => d.name === 'autotask_create_company') as any;
    expect(def.inputSchema.properties.customer_type.enum).toEqual(['business', 'residential', 'vendor']);
  });
});
