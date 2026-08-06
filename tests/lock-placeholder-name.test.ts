/**
 * Placeholder-name refusal on /contact-lock.
 *
 * Cases are the real fabrications measured 2026-08-06 across 314 lock_contact
 * calls carrying a spoken name since 07-23, plus the real callers that must
 * keep working.
 */
// autotask-node ships ESM jest cannot parse; the existing suites mock it the
// same way. isPlaceholderSpokenName is pure and touches nothing.
jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no live API in tests')) }
}));

import { isPlaceholderSpokenName, NO_NAME_GUIDANCE } from '../src/mcp/server';

describe('refuses names no caller gives', () => {
  it.each([
    ['John', 'Smith'],      // 08-03 11:19, 08-04 13:38, 08-06 10:18
    ['john', 'smith'],
    ['  John ', ' Smith. '],
    ['Jane', 'Doe'],
    ['John', 'Doe'],
    ['Jane', 'Smith'],
    ['Unknown', 'Unknown'],  // 07-30 09:14
    ['Unknown', ''],
    ['', 'Unknown'],
    ['Test', 'Test'],
    ['Caller', ''],
    ['Firstname', 'Lastname'],
  ])('refuses %s %s', (f, l) => {
    expect(isPlaceholderSpokenName(f, l)).toBe(true);
  });
});

describe('lets real callers through', () => {
  it.each([
    // Bruce Rideout is a REAL customer. It was fabricated three times only
    // because it sat in a tool description; that source is gone. Blocking the
    // name would refuse the actual person.
    ['Bruce', 'Rideout'],
    ['Tom', 'Daus'],
    ['Kristine (Kristi)', 'Even'],
    ['Amy', 'Herring'],
    ['Avelina', 'Ledford'],
    ['Marie', 'Zgheib'],
    ['Steven', 'Mercado'],
    // Smith and Doe are ordinary surnames on their own.
    ['Leonard', 'Smith'],
    ['Barbara', 'Smith'],
    ['John', 'Kelly'],
    ['John', 'Vannizzaro'],
    ['Jane', 'Goodall'],
    ['Smith', ''],
    ['', 'Smith'],
    // A first name only, which the lock legitimately accepts
    ['Justin', ''],
  ])('allows %s %s', (f, l) => {
    expect(isPlaceholderSpokenName(f, l)).toBe(false);
  });

  it('an empty call is not a placeholder — other branches handle it', () => {
    expect(isPlaceholderSpokenName('', '')).toBe(false);
    expect(isPlaceholderSpokenName(null, undefined)).toBe(false);
  });
});

describe('the refusal gives her nothing to read out', () => {
  // Brian, 2026-08-06: she did not just invent the name, she said it to the
  // caller. Asserts the REAL exported string, not a copy -- an earlier version
  // of this test declared its own and would have passed against stale source.
  it('never echoes a submitted name', () => {
    for (const n of ['John', 'Smith', 'Jane', 'Doe', 'Unknown']) {
      expect(NO_NAME_GUIDANCE.toLowerCase()).not.toContain(n.toLowerCase());
    }
  });

  it('contains no negative-lookup phrasing she could narrate', () => {
    for (const frame of ['not found', 'no contact', 'no record', "don't have",
                         'do not have', 'placeholder', 'fake', 'invalid', 'not on file']) {
      expect(NO_NAME_GUIDANCE.toLowerCase()).not.toContain(frame);
    }
  });

  it('says there is nothing to report, and forbids inventing', () => {
    expect(NO_NAME_GUIDANCE).toMatch(/nothing to tell the caller/);
    expect(NO_NAME_GUIDANCE).toMatch(/[Nn]ever use a name the caller did not say/);
  });

  it('stays short — Brian, 2026-08-06: "it is a paragraph, could be simpler"', () => {
    expect(NO_NAME_GUIDANCE.split(/\s+/).length).toBeLessThanOrEqual(45);
    expect(NO_NAME_GUIDANCE.split('.').filter(x => x.trim()).length).toBeLessThanOrEqual(3);
  });
});
