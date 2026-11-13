import { companyKey, companySearchWord, pickSpokenCompany, exactFullNameLock, SPOKEN_COMPANY_SCOPE_RIDER, SPOKEN_COMPANY_NEED_LAST_GUIDANCE, SPOKEN_COMPANY_ASK_GUIDANCE } from '../src/utils/spoken-company-lock';

// Synthetic names only. This repository is public.
const COMPANIES = [
  { id: 1, companyName: 'Northwind Builders Inc.' },
  { id: 2, companyName: 'Harbor Electrical' },
  { id: 3, companyName: "Kestrel, Lane & Moss CPAs, Inc." },
  { id: 4, companyName: 'Lantern Shows' },
  { id: 5, companyName: 'Harbor Electric Supply' },
  { id: 6, companyName: 'Quill, Avery', isResidential: true },
];

const POOL = [
  { id: 101, firstName: 'Avery', lastName: 'Quill', companyID: 1, primaryContact: true },
  { id: 102, firstName: 'Avery', lastName: 'Quillon', companyID: 1 },
  { id: 103, firstName: 'Jordan', lastName: 'Pike', companyID: 1 },
  { id: 104, firstName: 'Jordan', lastName: 'Pike', companyID: 1 },
];

describe('companyKey', () => {
  it('drops punctuation, apostrophes and legal suffixes', () => {
    expect(companyKey("Lantern Show's")).toBe('lanternshows');
    expect(companyKey('Northwind Builders Inc.')).toBe('northwindbuilders');
    expect(companyKey('Kestrel, Lane & Moss CPAs, Inc.')).toBe('kestrellanemosscpas');
  });
});

describe('companySearchWord', () => {
  it('uses the longest word, never a legal suffix', () => {
    expect(companySearchWord('Northwind Builders Inc.')).toBe('Northwind');
    expect(companySearchWord("Lantern Show's")).toBe('Lantern');
    expect(companySearchWord('Inc')).toBe('');
  });
});

describe('pickSpokenCompany', () => {
  it('matches a shortened or reworded name to exactly one company', () => {
    expect(pickSpokenCompany(COMPANIES, 'Northwind Builders')?.id).toBe(1);
    expect(pickSpokenCompany(COMPANIES, "Lantern Show's")?.id).toBe(4);
    expect(pickSpokenCompany(COMPANIES, 'Kestrel, Lane, Moss')?.id).toBe(3);
  });
  it('refuses when two companies fit', () => {
    expect(pickSpokenCompany(COMPANIES, 'Harbor Electric')).toBeNull();
  });
  it('never picks a residential account', () => {
    expect(pickSpokenCompany(COMPANIES, 'Quill')).toBeNull();
  });
  it('refuses when nothing fits or the answer is too short', () => {
    expect(pickSpokenCompany(COMPANIES, 'Northwind Plastics')).toBeNull();
    expect(pickSpokenCompany(COMPANIES, 'NB')).toBeNull();
  });
});

describe('exactFullNameLock', () => {
  it('locks an exact first and last name', () => {
    expect(exactFullNameLock(POOL, 'Avery', 'Quill')?.id).toBe(101);
  });
  it('does not lock without a last name', () => {
    expect(exactFullNameLock(POOL, 'Avery', '')).toBeNull();
  });
  it('does not lock a fuzzy surname or a wrong first name', () => {
    expect(exactFullNameLock(POOL, 'Avery', 'Quil')).toBeNull();
    expect(exactFullNameLock(POOL, 'Avry', 'Quill')).toBeNull();
  });
  it('does not lock when two contacts share the name', () => {
    expect(exactFullNameLock(POOL, 'Jordan', 'Pike')).toBeNull();
  });
});

describe('guidance wording', () => {
  it('stays affirmative and names no company', () => {
    for (const g of [SPOKEN_COMPANY_SCOPE_RIDER, SPOKEN_COMPANY_NEED_LAST_GUIDANCE, SPOKEN_COMPANY_ASK_GUIDANCE]) {
      expect(g).not.toMatch(/\bnot found\b|\bno record\b/i);
    }
  });
});
