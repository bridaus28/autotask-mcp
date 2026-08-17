/**
 * Name guards (S2), callerPhone persistence (S1) and duplicate-create replay
 * on autotask_create_contact / autotask_create_company. 2026-08-15.
 *
 * Incidents these encode: conv_3901 08-12 (empty lastName -> Autotask 500);
 * "Alma South Hills Escrow" 08-10 (company in the surname field); contacts
 * 30693335/37/38/43 (created with no phone on any field, can never match a
 * future call); companies 6870/6871 "Ricela" (retry-after-abandon duplicate,
 * 2s apart); conv yrm2z81f 08-11 (identical create_contact fired twice).
 */
jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no live API in tests')) }
}));

import { AutotaskToolHandler } from '../src/handlers/tool.handler';

const RD_RUBBER = 328;
const SOUTH_HILLS = 7001;
const NEW_CO = 6869;

const CONTACTS: any[] = [
  { id: 30699001, firstName: 'Colleague', lastName: 'OnFile', companyID: RD_RUBBER,
    phone: '+15622025244', isActive: 1 },
  { id: 30699002, firstName: 'Existing', lastName: 'Person', companyID: SOUTH_HILLS,
    phone: '+16269674350', isActive: 1 },
];
const COMPANIES: Record<number, any> = {
  [RD_RUBBER]:   { id: RD_RUBBER,   companyName: 'RD Rubber Technology Corp.', phone: '+1 562-926-1000' },
  [SOUTH_HILLS]: { id: SOUTH_HILLS, companyName: 'South Hills Escrow',         phone: '626-967-4350' },
  [NEW_CO]:      { id: NEW_CO,      companyName: 'Brand New Shell',            phone: '' },
};
const EMPTY = new Set<number>([NEW_CO]);

function makeHandler() {
  const created: any[] = [];
  const createdCompanies: any[] = [];
  let nextId = 90000;
  const service: any = {
    async companyHasContacts(id: number) { return !EMPTY.has(id); },
    async searchContacts({ phone }: any) {
      const digits = (s: string) => String(s ?? '').replace(/\D/g, '').slice(-10);
      return CONTACTS.filter(c => digits(c.phone) === digits(phone) || digits(c.mobilePhone) === digits(phone));
    },
    async getCompany(id: number) { return COMPANIES[id] ?? null; },
    async findActiveContactsByEmail() { return []; },
    async createContact(fields: any) { created.push(fields); return ++nextId; },
    async createCompany(fields: any) { createdCompanies.push(fields); return ++nextId; },
    testConnection: async () => true,
  };
  const handler = new AutotaskToolHandler(service, { info(){}, warn(){}, error(){}, debug(){} } as any);
  (handler as any).getMappingService = async () => ({ getCompanyName: async () => null, getResourceName: async () => null });
  return { handler, created, createdCompanies };
}
const call = (h: any, args: any) => h.callTool('autotask_create_contact', args);
const callCo = (h: any, args: any) => h.callTool('autotask_create_company', args);
const text = (r: any) => JSON.stringify(r);

describe('S2 name guards', () => {
  test('empty lastName is a question, not a field', async () => {
    const { handler, created } = makeHandler();
    const r = await call(handler, { companyID: RD_RUBBER, firstName: 'Tim', lastName: '', callerPhone: '+15622025244' });
    expect(text(r)).toContain('last_name_required');
    expect(created).toHaveLength(0);
  });
  test('placeholder pair refused', async () => {
    const { handler, created } = makeHandler();
    const r = await call(handler, { companyID: RD_RUBBER, firstName: 'John', lastName: 'Smith', callerPhone: '+15622025244' });
    expect(text(r)).toContain('placeholder_name');
    expect(created).toHaveLength(0);
  });
  test('surname "Unknown" refused', async () => {
    const { handler, created } = makeHandler();
    const r = await call(handler, { companyID: RD_RUBBER, firstName: 'Kristin', lastName: 'Unknown', callerPhone: '+15622025244' });
    expect(text(r)).toContain('placeholder_name');
    expect(created).toHaveLength(0);
  });
  test('company name in the surname field refused', async () => {
    const { handler, created } = makeHandler();
    const r = await call(handler, { companyID: SOUTH_HILLS, firstName: 'Alma', lastName: 'South Hills Escrow', callerPhone: '+16269674350' });
    expect(text(r)).toContain('company_name_as_surname');
    expect(created).toHaveLength(0);
  });
  test('corporate designator surname refused even when company lookup fails', async () => {
    const { handler, created } = makeHandler();
    const r = await call(handler, { companyID: RD_RUBBER, firstName: 'Bob', lastName: 'Acme LLC', callerPhone: '+15622025244' });
    expect(text(r)).toContain('company_name_as_surname');
    expect(created).toHaveLength(0);
  });
  test('real multi-word surname passes', async () => {
    const { handler, created } = makeHandler();
    const r = await call(handler, { companyID: RD_RUBBER, firstName: 'Maria', lastName: 'De La Cruz', callerPhone: '+15622025244' });
    expect(text(r)).toContain('Successfully created');
    expect(created).toHaveLength(1);
  });
});

describe('S1 callerPhone persistence', () => {
  test('callerPhone lands on the record when no phone was given', async () => {
    const { handler, created } = makeHandler();
    await call(handler, { companyID: RD_RUBBER, firstName: 'Maria', lastName: 'Delgado', callerPhone: '+15622025244' });
    expect(created[0].phone).toBe('+15622025244');
    expect(created[0].callerPhone).toBeUndefined();
  });
  test('a provided phone is never overwritten', async () => {
    const { handler, created } = makeHandler();
    await call(handler, { companyID: RD_RUBBER, firstName: 'Maria', lastName: 'Delgado', phone: '+19095551234', callerPhone: '+15622025244' });
    expect(created[0].phone).toBe('+19095551234');
  });
  test('persists on brand-new (gate-skipped) companies too', async () => {
    const { handler, created } = makeHandler();
    await call(handler, { companyID: NEW_CO, firstName: 'Mary', lastName: 'Lynn', callerPhone: '+16024631044' });
    expect(created[0].phone).toBe('+16024631044');
  });
});

describe('literal-phone guard', () => {
  test('the variable NAME as a phone is refused (observed live 2026-08-16)', async () => {
    const { handler, created } = makeHandler();
    const r = await call(handler, { companyID: RD_RUBBER, firstName: 'Ben', lastName: 'Blech', callerPhone: 'system__caller_id' });
    expect(JSON.stringify(r)).toContain('caller_phone_invalid');
    expect(created).toHaveLength(0);
  });
  test('a real number still passes', async () => {
    const { handler, created } = makeHandler();
    await call(handler, { companyID: RD_RUBBER, firstName: 'Maria', lastName: 'Delgado', callerPhone: '+15622025244' });
    expect(created).toHaveLength(1);
  });
});

describe('duplicate-create replay', () => {
  test('identical create_contact seconds apart writes once', async () => {
    const { handler, created } = makeHandler();
    const r1 = await call(handler, { companyID: RD_RUBBER, firstName: 'Daniel', lastName: 'Amini', emailAddress: 'daniel@example.com', callerPhone: '+15622025244' });
    const r2 = await call(handler, { companyID: RD_RUBBER, firstName: 'Daniel', lastName: 'Amini', emailAddress: 'daniel@example.com', callerPhone: '+15622025244' });
    expect(created).toHaveLength(1);
    expect(text(r2)).toBe(text(r1));
  });
  test('identical create_company seconds apart writes once (the Ricela pattern)', async () => {
    const { handler, createdCompanies } = makeHandler();
    const args = { companyName: 'Ricela', customer_type: 'residential', phone: '+16265551212' };
    const r1 = await callCo(handler, { ...args });
    const r2 = await callCo(handler, { ...args });
    expect(createdCompanies).toHaveLength(1);
    expect(text(r2)).toBe(text(r1));
  });
  test('different names are not replays', async () => {
    const { handler, created } = makeHandler();
    await call(handler, { companyID: RD_RUBBER, firstName: 'Daniel', lastName: 'Amini', callerPhone: '+15622025244' });
    await call(handler, { companyID: RD_RUBBER, firstName: 'Diana', lastName: 'Amini', callerPhone: '+15622025244' });
    expect(created).toHaveLength(2);
  });
});

describe('S3 roster-dump refusal', () => {
  test('empty searchTerm on search_resources is refused', async () => {
    const { handler } = makeHandler();
    const r = await handler.callTool('autotask_search_resources', { searchTerm: '' });
    expect(JSON.stringify(r)).toContain('search_term_required');
  });
  test('a real name still searches', async () => {
    const { handler } = makeHandler();
    (handler as any).autotaskService.searchResources = async () => [{ id: 1, firstName: 'Tina' }];
    const r = await handler.callTool('autotask_search_resources', { searchTerm: 'Tina' });
    expect(JSON.stringify(r)).toContain('\\"returned\\":1');
  });
});

// ─── B14: create_company phone-first dedupe (2026-08-17) ────────────────────
describe('B14 create_company dedupe', () => {

  test('returns the existing company on a phone match instead of creating', async () => {
    const { handler, createdCompanies } = makeHandler();
    (handler as any)['autotaskService'].searchCompanies = async (q: any) =>
      q.phone ? [{ id: 175, companyName: 'Test Billing Company', isActive: 1 }] : [];
    const r: any = await callCo(handler, { companyName: 'Ivy Dedupe Probe Co', phone: '1 909-599-5058', customer_type: 'business' });
    expect(text(r)).toContain('existing_company');
    expect(text(r)).toContain('175');
    expect(createdCompanies.length).toBe(0);
  });
  test('creates when nothing matches', async () => {
    const { handler, createdCompanies } = makeHandler();
    (handler as any)['autotaskService'].searchCompanies = async () => [];
    await callCo(handler, { companyName: 'Genuinely New Co', phone: '909-555-0000', customer_type: 'business' });
    expect(createdCompanies.length).toBe(1);
  });
  test('lookup failure falls through to create', async () => {
    const { handler, createdCompanies } = makeHandler();
    (handler as any)['autotaskService'].searchCompanies = async () => { throw new Error('down'); };
    await callCo(handler, { companyName: 'Fallthrough Co', phone: '909-555-0001', customer_type: 'business' });
    expect(createdCompanies.length).toBe(1);
  });
});

// ─── B15: company web domain from contact email (2026-08-17) ────────────────
// Each test uses a unique contact name: the module-level replay memo would
// otherwise short-circuit every test after the first. co.phone matches the
// callerPhone so the tie gate admits the create.
describe('B15 domain from email', () => {
  const mk = (co: any) => {
    const { handler, created } = makeHandler();
    const updates: any[] = [];
    (handler as any)['autotaskService'].getCompany = async () => ({ phone: '+1 562-202-5244', ...co });
    (handler as any)['autotaskService'].updateCompany = async (_id: number, u: any) => { updates.push(u); };
    return { handler, created, updates };
  };
  const args = (last: string) => ({ companyID: RD_RUBBER, firstName: 'Web', lastName: last, callerPhone: '+15622025244' });

  test('custom domain fills an empty webAddress', async () => {
    const { handler, updates } = mk({ id: RD_RUBBER, webAddress: '', classification: 17 });
    await call(handler, { ...args('Alpha'), emailAddress: 'web@rdrubber.com' });
    expect(updates).toEqual([{ webAddress: 'rdrubber.com' }]);
  });
  test('freemail domain writes nothing', async () => {
    const { handler, updates } = mk({ id: RD_RUBBER, webAddress: '', classification: 17 });
    await call(handler, { ...args('Bravo'), emailAddress: 'web@gmail.com' });
    expect(updates).toEqual([]);
  });
  test('existing webAddress is never overwritten', async () => {
    const { handler, updates } = mk({ id: RD_RUBBER, webAddress: 'rdrubber.com', classification: 17 });
    await call(handler, { ...args('Charlie'), emailAddress: 'web@otherdomain.com' });
    expect(updates).toEqual([]);
  });
  test('residential accounts never get a web domain', async () => {
    const { handler, updates } = mk({ id: RD_RUBBER, webAddress: '', classification: 13 });
    await call(handler, { ...args('Delta'), emailAddress: 'web@familybiz.com' });
    expect(updates).toEqual([]);
  });
  test('no email, no lookup, create still succeeds', async () => {
    const { handler, created, updates } = mk({ id: RD_RUBBER, webAddress: '' });
    await call(handler, args('Echo'));
    expect(created.length).toBe(1);
    expect(updates).toEqual([]);
  });
  test('domain-write failure never disturbs the create', async () => {
    const { handler, created } = makeHandler();
    (handler as any)['autotaskService'].getCompany = async () => { throw new Error('down'); };
    await call(handler, { ...args('Foxtrot'), emailAddress: 'web@rdrubber.com' });
    expect(created.length).toBe(1);
  });
});
