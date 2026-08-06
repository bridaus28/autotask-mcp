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

import { isPlaceholderSpokenName } from '../src/mcp/server';

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
  // caller. These assert the shape of the response text, not the behaviour --
  // the server cannot control what she says, only what she is handed.
  const GUIDANCE = 'No name has been given on this call yet. Ask the caller who you are speaking with, then call this tool again with their answer. Nothing was looked up, so there is no result to tell them about.';

  it('never echoes a submitted name', () => {
    for (const n of ['John', 'Smith', 'Jane', 'Doe', 'Unknown']) {
      expect(GUIDANCE.toLowerCase()).not.toContain(n.toLowerCase());
    }
  });

  it('contains no negative-lookup phrasing she could narrate', () => {
    for (const frame of ['not found', 'no contact', 'no record', "don't have",
                         'do not have', 'placeholder', 'fake', 'invalid', 'not on file']) {
      expect(GUIDANCE.toLowerCase()).not.toContain(frame);
    }
  });

  it('says plainly that there is nothing to report', () => {
    expect(GUIDANCE).toMatch(/no result to tell them about/);
  });
});
