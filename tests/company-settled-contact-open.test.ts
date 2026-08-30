/**
 * A company carried by several contacts on one phone settles the ACCOUNT, not
 * the PERSON. 2026-08-30, from Brian's test call conv_5201m1894g90fvb99vza46etgywy.
 *
 * Scoring runs per contact, so his office number -- seven colleagues at Daus
 * Technologies Corporation -- produced seven identical top scores and the tie
 * check refused to lock, making the account unreachable from that phone even
 * when he said its name exactly.
 *
 * The first attempt at this fix locked the primary contact, which would have
 * answered Brian as "Tom". The locked verdict feeds a response carrying
 * first_name/last_name; choosing a person here is choosing who the caller is.
 * So: settle the company, stop, ask who is calling.
 */
jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no live API in tests')) }
}));

import { matchSpokenCompany } from '../src/utils/company-match';

const DAUS = (n: number) => Array.from({ length: n }, (_, i) => ({
  contactId: 100 + i, companyId: 1769,
  companyName: 'Daus Technologies Corporation',
  classification: 'Silver Managed Service', primaryContact: i === 0,
}));
const TEST_BRIAN = { contactId: 200, companyId: 7710, companyName: 'Test Brian', classification: 'T&M', primaryContact: false };
const REAL = [...DAUS(7), TEST_BRIAN] as any;

describe('company settled, contact still open', () => {
  test('the exact company name settles the account without naming a person', () => {
    const r: any = matchSpokenCompany(REAL, 'Daus Technologies Corporation');
    expect(r.status).toBe('company_only');
    expect(r.companyId).toBe(1769);
    expect(r.count).toBe(7);
    expect(r.candidate).toBeUndefined();
  });

  test('the misheard name from the call settles it too', () => {
    const r: any = matchSpokenCompany(REAL, 'Daust Technologies');
    expect(r.status).toBe('company_only');
    expect(r.companyId).toBe(1769);
  });

  test('it never picks the primary contact - Brian is not Tom', () => {
    const r: any = matchSpokenCompany(REAL, 'Daus Technologies');
    expect(r.status).not.toBe('locked');
    expect(JSON.stringify(r)).not.toContain('100');
  });
});

describe('unchanged behaviour', () => {
  test('one contact at the matched company still locks the person', () => {
    const one = [DAUS(1)[0], TEST_BRIAN] as any;
    const r: any = matchSpokenCompany(one, 'Daus Technologies');
    expect(r.status).toBe('locked');
    expect(r.candidate.companyId).toBe(1769);
  });

  test('the other account on the same phone still locks on its own name', () => {
    const r: any = matchSpokenCompany(REAL, 'Test Brian');
    expect(r.status).toBe('locked');
    expect(r.candidate.companyId).toBe(7710);
  });

  test('two different companies tying is still ambiguous, counted as companies', () => {
    const two = [
      { contactId: 1, companyId: 11, companyName: 'Summit Dental', classification: 'T&M', primaryContact: true },
      { contactId: 2, companyId: 11, companyName: 'Summit Dental', classification: 'T&M', primaryContact: false },
      { contactId: 3, companyId: 12, companyName: 'Summit Dental Group', classification: 'T&M', primaryContact: true },
    ] as any;
    const r: any = matchSpokenCompany(two, 'Summit Dental');
    expect(r.status).toBe('ambiguous_company');
    expect(r.count).toBe(2);
  });

  test('a name matching nothing is still no_match', () => {
    expect(matchSpokenCompany(REAL, 'Northwind Traders').status).toBe('company_no_match');
  });

  test('"not a company" with no residential account is now its own verdict', () => {
    // Split out 2026-08-30 so the guidance can name the real situation. The
    // caller-visible status the server emits is still company_no_match, so
    // nothing changes for Ivy except the sentence she is handed.
    expect(matchSpokenCompany(REAL, 'not a company').status).toBe('no_residential_account');
  });

  test('tied candidates with no company id never settle an account', () => {
    const nulls = [
      { contactId: 1, companyId: null, companyName: 'Alpha Co', classification: null, primaryContact: false },
      { contactId: 2, companyId: null, companyName: 'Alpha Co', classification: null, primaryContact: false },
    ] as any;
    expect(matchSpokenCompany(nulls, 'Alpha').status).toBe('ambiguous_company');
  });
});

// ─── Use the name already given; name the real dead end (2026-08-30) ────────
import {
  COMPANY_SETTLED_GUIDANCE,
  NO_RESIDENTIAL_ON_PHONE_GUIDANCE,
} from '../src/mcp/server';

describe('"not a company" on a phone with no personal account', () => {
  // Brian's 08-29 test: he answered "My business" and the residential token was
  // sent anyway. Also ft65nqys ("Both") and 2ycgyc03 ("Yeah") this week. The
  // generic no-match text sent her back for a spelling nobody had asked for.
  test('is its own verdict, not a failed company name', () => {
    expect(matchSpokenCompany(REAL, 'not a company').status).toBe('no_residential_account');
  });
  test('one residential account still locks', () => {
    const r: any = matchSpokenCompany([
      { contactId: 1, companyId: 900, companyName: 'Garcia, Cindy', classification: 'Residential', primaryContact: true },
      TEST_BRIAN,
    ] as any, 'not a company');
    expect(r.status).toBe('locked');
    expect(r.via).toBe('residential');
  });
  test('two residential accounts are still ambiguous_residential', () => {
    const r: any = matchSpokenCompany([
      { contactId: 1, companyId: 900, companyName: 'Garcia, Cindy', classification: 'Residential', primaryContact: true },
      { contactId: 2, companyId: 901, companyName: 'Garcia, C', classification: 'Residential', primaryContact: true },
    ] as any, 'not a company');
    expect(r.status).toBe('ambiguous_residential');
    expect(r.count).toBe(2);
  });
  test('other home-shaped answers reach the same verdict', () => {
    for (const s of ['home', 'personal', 'residential', 'myself'])
      expect(matchSpokenCompany(REAL, s).status).toBe('no_residential_account');
  });
});

describe('guidance wording', () => {
  test('a name already given is used, not asked for twice', () => {
    expect(COMPANY_SETTLED_GUIDANCE).toContain('already given you');
    expect(COMPANY_SETTLED_GUIDANCE).toContain('do not ask for it a second time');
    expect(COMPANY_SETTLED_GUIDANCE).toContain('only if you have no name yet');
  });
  test('the account is still never read out as a list of people', () => {
    expect(COMPANY_SETTLED_GUIDANCE).toContain('Never name or list the people on file');
  });
  test('the no-personal-account fact stays internal', () => {
    expect(NO_RESIDENTIAL_ON_PHONE_GUIDANCE).toContain('Do not tell the caller that');
    expect(NO_RESIDENTIAL_ON_PHONE_GUIDANCE).toContain('ask which company');
  });
  test('it never tells her to ask for a spelling she was not owed', () => {
    expect(NO_RESIDENTIAL_ON_PHONE_GUIDANCE.toLowerCase()).not.toContain('spell');
  });
});
