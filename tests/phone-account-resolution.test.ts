/**
 * A phone reaches us two ways: on a CONTACT, or as a company's MAIN number.
 * 2026-08-30 (Brian).
 *
 * /phone-lookup handled both and /contact-lock handled only the first, inside
 * the same service. Measured 3 May - 30 Aug 2026: 56 calls arrived on a company
 * main number and produced 41 no_record against 1 lock. The account was known
 * to the system every time; the caller was told their own office was not on
 * file. Roughly fourteen calls a month since May.
 */
jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no live API in tests')) }
}));

import { resolvePhoneAccount } from '../src/mcp/server';

const MAIN = '+19095551000';
const CONTACT_PHONE = '+19095552000';

const CONTACTS_ON_MAIN = [
  { id: 1, firstName: 'Jolin',  lastName: 'Davidson', companyID: 6878, primaryContact: true },
  { id: 2, firstName: 'Marcus', lastName: 'Reyes',    companyID: 6878, primaryContact: false },
];

function svc(opts: { contactsByPhone?: any[]; companiesByPhone?: any[]; contactsByCompany?: any[]; throwOnCompanies?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    async searchContacts(o: any) {
      if (o.phone !== undefined) { calls.push('searchContacts:phone'); return opts.contactsByPhone ?? []; }
      calls.push('searchContacts:company'); return opts.contactsByCompany ?? [];
    },
    async searchCompanies(_o: any) {
      calls.push('searchCompanies:phone');
      if (opts.throwOnCompanies) throw new Error('Autotask 500');
      return opts.companiesByPhone ?? [];
    },
  };
}

describe('the phone is carried by a contact', () => {
  test('resolves from contacts and never asks about companies', async () => {
    const s = svc({ contactsByPhone: [{ id: 9, firstName: 'Kim', lastName: 'Braun', companyID: 594 }] });
    const r = await resolvePhoneAccount(s, CONTACT_PHONE);
    expect(r.via).toBe('contacts');
    expect(r.companyIds).toEqual([594]);
    expect(s.calls).not.toContain('searchCompanies:phone');
  });

  test('several accounts on the phone stay several - the ambiguous path is untouched', async () => {
    const s = svc({ contactsByPhone: [
      { id: 1, firstName: 'Eric', lastName: 'Pivaroff', companyID: 398 },
      { id: 2, firstName: 'Eric', lastName: 'Pivaroff', companyID: 6566 },
    ]});
    const r = await resolvePhoneAccount(s, CONTACT_PHONE);
    expect(r.via).toBe('contacts');
    expect(r.companyIds.sort()).toEqual([398, 6566]);
  });
});

describe('the phone is a company main number', () => {
  test('resolves to that company and its contacts - the Jolin Davidson call', async () => {
    const s = svc({
      contactsByPhone: [],
      companiesByPhone: [{ id: 6878, companyName: 'Davidson, Jolin', isActive: true }],
      contactsByCompany: CONTACTS_ON_MAIN,
    });
    const r = await resolvePhoneAccount(s, MAIN);
    expect(r.via).toBe('company_main_phone');
    expect(r.companyIds).toEqual([6878]);
    expect(r.pool).toHaveLength(2);
  });

  test('prefers an active company over an inactive one', async () => {
    const s = svc({
      contactsByPhone: [],
      companiesByPhone: [
        { id: 111, companyName: 'Old Shell', isActive: false },
        { id: 6878, companyName: 'Davidson, Jolin', isActive: true },
      ],
      contactsByCompany: CONTACTS_ON_MAIN,
    });
    expect((await resolvePhoneAccount(s, MAIN)).companyIds).toEqual([6878]);
  });
});

describe('exits when the data does not match reality', () => {
  test('a company with no contacts does not resolve - nothing to lock against', async () => {
    const s = svc({ contactsByPhone: [], companiesByPhone: [{ id: 6878, isActive: true }], contactsByCompany: [] });
    const r = await resolvePhoneAccount(s, MAIN);
    expect(r.via).toBe('none');
    expect(r.companyIds).toEqual([]);
  });

  test('a phone matching nothing at all stays unresolved', async () => {
    const r = await resolvePhoneAccount(svc(), '+15550000000');
    expect(r.via).toBe('none');
    expect(r.pool).toEqual([]);
  });

  test('an Autotask error fails open to today behaviour, never throws', async () => {
    const s = svc({ contactsByPhone: [], throwOnCompanies: true });
    const r = await resolvePhoneAccount(s, MAIN);
    expect(r.via).toBe('none');
    expect(r.companyIds).toEqual([]);
  });

  test('an empty phone never triggers a company search', async () => {
    const s = svc({ contactsByPhone: [] });
    const r = await resolvePhoneAccount(s, '');
    expect(r.via).toBe('none');
    expect(s.calls).not.toContain('searchCompanies:phone');
  });
});
