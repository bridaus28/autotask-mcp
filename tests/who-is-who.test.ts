/**
 * Who-is-who completion (2026-08-18, Brian).
 *
 * The rule: a name never becomes a fact -- never filed, never spoken --
 * until checked against both lists (tech roster, account contacts).
 * Language picks which check runs first; it never finalizes.
 */
jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no live API in tests')) }
}));

import {
  loneFirstTechMatch, targetOrSelfGuidance, bothListsGuidance,
  isBusinessLiteralAnswer, BUSINESS_LITERAL_GUIDANCE, AMBIGUOUS_COMPANY_BINARY_GUIDANCE,
  RosterTech,
} from '../src/utils/name-match';

const ROSTER: RosterTech[] = [
  { firstName: 'Jason',  lastName: 'Miller',  officeExtension: '1005' },
  { firstName: 'Joshua', lastName: 'Joseph',  officeExtension: '1011' },
  { firstName: 'Ben',    lastName: 'Oden',    officeExtension: '1004' },
  { firstName: 'Brian',  lastName: 'Gudauskas', officeExtension: '1001' },
  { firstName: 'Sam',    lastName: 'Gomez',   officeExtension: '1007' },
];

describe('lone-first tech match (the "Calling for Brian" case, 08-18 09:50)', () => {
  it.each([
    ['Brian'], ['brian'], [' Jason '], ['Ben'],
  ])('flags lone %s uniquely', (f) => {
    expect(loneFirstTechMatch(f, '', ROSTER)).not.toBeNull();
  });

  it('never fires when ANY last name is present — full names are the guard\'s job', () => {
    expect(loneFirstTechMatch('Brian', 'Smith', ROSTER)).toBeNull();
    expect(loneFirstTechMatch('Jason', 'Miller', ROSTER)).toBeNull();
  });

  it('never fires on non-roster first names', () => {
    expect(loneFirstTechMatch('Kim', '', ROSTER)).toBeNull();
    expect(loneFirstTechMatch('Cynthia', '', ROSTER)).toBeNull();
  });

  it('stays silent when two techs share the first name (not unique)', () => {
    const r = [...ROSTER, { firstName: 'Brian', lastName: 'Second', officeExtension: '1019' }];
    expect(loneFirstTechMatch('Brian', '', r)).toBeNull();
  });

  it('exact only — a mangled lone first name does not fire', () => {
    expect(loneFirstTechMatch('Brain', '', ROSTER)).toBeNull();
  });
});

describe('both-lists collision + target-or-self guidance', () => {
  it('both guidances carry the name and ask the caller to adjudicate', () => {
    expect(targetOrSelfGuidance('Brian')).toMatch(/reach Brian, or is Brian your/);
    expect(bothListsGuidance('Jason Miller')).toMatch(/your name, or the person/);
  });
  it('both define the exit path (re-lock accepted / tech-status tool)', () => {
    expect(targetOrSelfGuidance('Brian')).toMatch(/tech-status/);
    expect(bothListsGuidance('Jason Miller')).toMatch(/again with the same name/);
  });
  it('affirmative-only: no prohibition phrasing', () => {
    for (const g of [targetOrSelfGuidance('Brian'), bothListsGuidance('Jason Miller'),
                     BUSINESS_LITERAL_GUIDANCE, AMBIGUOUS_COMPANY_BINARY_GUIDANCE]) {
      expect(g).not.toMatch(/\bdo not\b|\bdon'?t\b/i);
    }
  });
});

describe('replay refinements (515 real lock calls, 2026-08-18)', () => {
  const { spokenEqualsTech } = require('../src/utils/name-match');
  it('Aaron Mills is NOT an exact collision with Jason Miller (both-lists stays silent)', () => {
    expect(spokenEqualsTech('Aaron', 'Mills', { firstName: 'Jason', lastName: 'Miller', officeExtension: '1005' })).toBe(false);
  });
  it('Jason Miller IS an exact collision (both-lists asks)', () => {
    expect(spokenEqualsTech('jason', ' MILLER ', { firstName: 'Jason', lastName: 'Miller', officeExtension: '1005' })).toBe(true);
  });
});

describe('business-literal answers (seam hit 2/2 organically, 08-17)', () => {
  it.each([
    ['Business'], ['business'], ['  Business. '], ['my business'], ['for work'],
    ['the office'], ['a company'], ['work'],
  ])('treats "%s" as an answer, not a company name', (a) => {
    expect(isBusinessLiteralAnswer(a)).toBe(true);
  });

  it.each([
    ['Innovative Display Works'],       // real company with "works"-adjacent words
    ['The Business Company LLC'],
    ['Office & Ergonomic Solutions'],
    ['New Start Home Health Care'],
    ['not a company'],                  // the home-side answer, handled elsewhere
    ['Covina Arthritis Clinic'],
    [''],
  ])('passes real company names through: "%s"', (a) => {
    expect(isBusinessLiteralAnswer(a)).toBe(false);
  });
});
