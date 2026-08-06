/**
 * Access gate + duplicate check on autotask_create_contact.
 *
 * Creating a contact grants access: the pre-call webhook matches inbound calls
 * on contact phone, so a contact carrying the caller's number makes every later
 * call from it read "Verified caller: <name> at <company>". Fixtures are real
 * rows and real numbers from live Autotask on 2026-08-05.
 */
jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no live API in tests')) }
}));

import { AutotaskToolHandler } from '../src/handlers/tool.handler';

const RD_RUBBER = 328;      // 80 contacts. Tini Vijaya was added here from an unknown phone.
const EVERLINE  = 6864;
const CBWCD     = 840;      // 63 contacts. Today's cross-account create.
const NEW_CO    = 6869;     // residential shell, no contacts yet
const PRO_AV    = 553;

const CONTACTS: any[] = [
  { id: 30693320, firstName: 'Kristine (Kristi)', lastName: 'Even', companyID: EVERLINE,
    mobilePhone: '13199391566', emailAddress: 'kacctllc@gmail.com', isActive: 1 },
  { id: 30684442, firstName: 'Emmanuel', lastName: 'Takahashi', companyID: PRO_AV,
    phone: '+15624841593', emailAddress: 'etakahashi@example.com', isActive: 1 },
  { id: 30699001, firstName: 'Colleague', lastName: 'OnFile', companyID: RD_RUBBER,
    phone: '+15622025244', isActive: 1 },
];
const COMPANIES: Record<number, any> = {
  [RD_RUBBER]: { id: RD_RUBBER, companyName: 'RD Rubber Technology Corp.', phone: '+1 562-926-1000' },
  [CBWCD]:     { id: CBWCD,     companyName: 'Chino Basin WCD',            phone: '1 909-626-2711' },
  [EVERLINE]:  { id: EVERLINE,  companyName: 'Everline Services, LLC',     phone: '2141112233' },
  [PRO_AV]:    { id: PRO_AV,    companyName: 'Pro Audio Video',            phone: '' },
  [NEW_CO]:    { id: NEW_CO,    companyName: 'Mary, Lynn',                 phone: '602-463-1044' },
};
const EMPTY = new Set<number>([NEW_CO]);

function makeHandler(opts: { gateThrows?: boolean } = {}) {
  const created: any[] = [];
  const service: any = {
    async companyHasContacts(id: number) {
      if (opts.gateThrows) throw new Error('autotask down');
      return !EMPTY.has(id);
    },
    async searchContacts({ phone }: any) {
      const digits = (s: string) => String(s ?? '').replace(/\D/g, '').slice(-10);
      return CONTACTS.filter(c => digits(c.phone) === digits(phone) || digits(c.mobilePhone) === digits(phone));
    },
    async getCompany(id: number) { return COMPANIES[id] ?? null; },
    async findActiveContactsByEmail(email: string) {
      return CONTACTS.filter(c => (c.emailAddress ?? '').toLowerCase() === email.trim().toLowerCase());
    },
    async createContact(fields: any) { created.push(fields); return 99999; },
    testConnection: async () => true,
  };
  const handler = new AutotaskToolHandler(service, { info(){}, warn(){}, error(){}, debug(){} } as any);
  (handler as any).getMappingService = async () => ({ getCompanyName: async () => null, getResourceName: async () => null });
  return { handler, created };
}
const call = (h: any, args: any) => h.callTool('autotask_create_contact', args);
const body = (r: any) => { const p = JSON.parse(r.content[0].text); return p.data ?? p; };

describe('the gate refuses', () => {
  it('an unknown phone at an established account — the 9 creates from the last 30 days', async () => {
    const { handler, created } = makeHandler();
    const out = body(await call(handler, {
      companyID: RD_RUBBER, firstName: 'Tini', lastName: 'Vijaya',
      callerPhone: '+15622025245',   // was not on file anywhere
    }));
    expect(created).toHaveLength(0);
    expect(out.status).toBe('not_tied_to_company');
  });

  it('a caller whose number ties to a DIFFERENT account — today, 13:28', async () => {
    const { handler, created } = makeHandler();
    const out = body(await call(handler, {
      companyID: CBWCD, firstName: 'Christy', lastName: 'Even',
      emailAddress: 'kacctllc@gmail.com', callerPhone: '+13199391566',
    }));
    expect(created).toHaveLength(0);
    expect(out.status).toBe('not_tied_to_company');
  });

  it('an omitted callerPhone, so it cannot be bypassed by leaving it out', async () => {
    const { handler, created } = makeHandler();
    const out = body(await call(handler, {
      companyID: RD_RUBBER, firstName: 'Anyone', lastName: 'Atall',
    }));
    expect(created).toHaveLength(0);
    expect(out.status).toBe('caller_phone_required');
  });

  it('fails CLOSED when Autotask cannot be reached', async () => {
    const { handler, created } = makeHandler({ gateThrows: true });
    const out = body(await call(handler, {
      companyID: RD_RUBBER, firstName: 'Anyone', lastName: 'Atall', callerPhone: '+15622025245',
    }));
    expect(created).toHaveLength(0);
    expect(out.status).toBe('gate_unavailable');
  });
});

describe('the gate allows', () => {
  it('a colleague dialling from a number already on file at that account', async () => {
    const { handler, created } = makeHandler();
    await call(handler, {
      companyID: RD_RUBBER, firstName: 'New', lastName: 'Hire', callerPhone: '+1 562-202-5244',
    });
    expect(created).toHaveLength(1);
    expect(created[0].companyID).toBe(RD_RUBBER);
  });

  it('a caller dialling in on the company main line', async () => {
    const { handler, created } = makeHandler();
    await call(handler, {
      companyID: CBWCD, firstName: 'Front', lastName: 'Desk', callerPhone: '+19096262711',
    });
    expect(created).toHaveLength(1);
  });

  it('residential intake into a brand-new company, with no callerPhone needed', async () => {
    const { handler, created } = makeHandler();
    await call(handler, {
      companyID: NEW_CO, firstName: 'Lynn', lastName: 'Mary', phone: '602-463-1044',
    });
    expect(created).toHaveLength(1);
  });

  it('never writes callerPhone onto the contact record', async () => {
    const { handler, created } = makeHandler();
    await call(handler, {
      companyID: RD_RUBBER, firstName: 'New', lastName: 'Hire', callerPhone: '+15622025244',
    });
    expect(created[0]).not.toHaveProperty('callerPhone');
  });
});

describe('duplicate check, once past the gate', () => {
  it('returns the existing contact rather than duplicating it', async () => {
    const { handler, created } = makeHandler();
    const out = body(await call(handler, {
      companyID: PRO_AV, firstName: 'Emmanuel', lastName: 'Takahashi',
      emailAddress: 'etakahashi@example.com', callerPhone: '+15624841593',
    }));
    expect(created).toHaveLength(0);
    expect(out.status).toBe('existing_contact');
    expect(out.contactID).toBe(30684442);
  });
});

describe('nothing is disclosed and nothing is asked', () => {
  it('a refusal names no person, company or id', async () => {
    const { handler } = makeHandler();
    const raw = await call(handler, {
      companyID: CBWCD, firstName: 'Christy', lastName: 'Even',
      emailAddress: 'kacctllc@gmail.com', callerPhone: '+13199391566',
    });
    const text = JSON.stringify(raw);
    for (const leak of ['Kristine', 'Kristi', 'Everline', '6864', '30693320']) {
      expect(text).not.toContain(leak);
    }
  });

  it('no message asks the caller anything', async () => {
    const { handler } = makeHandler();
    for (const args of [
      { companyID: RD_RUBBER, firstName: 'Tini', lastName: 'Vijaya', callerPhone: '+15622025245' },
      { companyID: RD_RUBBER, firstName: 'A', lastName: 'B' },
      { companyID: PRO_AV, firstName: 'Emmanuel', lastName: 'Takahashi',
        emailAddress: 'etakahashi@example.com', callerPhone: '+15624841593' },
    ]) {
      const parsed = JSON.parse((await call(handler, args)).content[0].text);
      expect(String(parsed.message ?? '')).not.toContain('?');
    }
  });
});
