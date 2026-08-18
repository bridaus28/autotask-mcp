/**
 * Tech-name guard on /contact-lock (2026-08-17).
 *
 * The defect, measured: Kim Braun (OES) 2026-08-03 14:27 asked "Can I speak
 * to Jason Miller?" and the lock received {"spoken_first":"Jason",
 * "spoken_last":"Miller"}. conv_1701 (08-12) is the same class: target's
 * name treated as the caller's. The guard reads a full-name roster collision
 * as "that is who they want to reach" and redirects to the transfer flow.
 */
// autotask-node ships ESM jest cannot parse; the existing suites mock it the
// same way. spokenNameMatchesTech is pure and touches nothing.
jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no live API in tests')) }
}));

import { spokenNameMatchesTech, TECH_NAME_GUIDANCE, RosterTech } from '../src/utils/name-match';

// Phone-routable roster shape: active resources WITH an office extension,
// exactly what getTechRoster() serves (mirrors autotask_lookup_tech_status).
const ROSTER: RosterTech[] = [
  { firstName: 'Jason',  lastName: 'Miller',  officeExtension: '1005' },
  { firstName: 'Joshua', lastName: 'Joseph',  officeExtension: '1011' },
  { firstName: 'Ben',    lastName: 'Oden',    officeExtension: '1004' },
  { firstName: 'Sam',    lastName: 'Gomez',   officeExtension: '1007' },
  { firstName: 'David',  lastName: 'Puga',    officeExtension: '1009' },
];

describe('redirects our own techs’ names', () => {
  it.each([
    ['Jason', 'Miller'],     // the Kim Braun call, verbatim
    ['jason', 'miller'],
    ['  Jason ', ' MILLER. '],
    ['Joshua', 'Joseph'],
    ['Ben', 'Oden'],
  ])('flags %s %s as a tech', (f, l) => {
    expect(spokenNameMatchesTech(f, l, ROSTER)).not.toBeNull();
  });

  it('returns the matched tech so the handler can log it', () => {
    const hit = spokenNameMatchesTech('Jason', 'Miller', ROSTER);
    expect(hit?.officeExtension).toBe('1005');
  });
});

describe('bounded fuzzy: STT mangling still hits (Brian, 08-17: STT never exact matches)', () => {
  it.each([
    ['Jason', 'Millar'],    // 1 edit on the surname
    ['Jasen', 'Miller'],    // 1 edit on the first
    ['Joshua', 'Josef'],    // 2 edits on a 6-char surname
    ['Been', 'Oden'],       // "Ben" heard long
    ['Sam', 'Gomes'],       // Gomez/Gomes, the Reina/Reyna class
  ])('flags %s %s', (f, l) => {
    expect(spokenNameMatchesTech(f, l, ROSTER)).not.toBeNull();
  });

  // Documented false-positive class: BOTH names inside threshold of a tech.
  // Rare (joint requirement), and bounded by two handler-side exits: the
  // pool-vouch (on-file contact stands the guard down) and the repeat
  // stand-down (same name given twice is the caller's own). Never a loop.
  it('Pam Gomez is a known near-collision with Sam Gomez (handled by stand-down)', () => {
    expect(spokenNameMatchesTech('Pam', 'Gomez', ROSTER)).not.toBeNull();
  });

  it.each([
    ['Jason', 'Mueller'],   // surname 2 edits + short-name budget respected? mueller->miller is 2, but first also off: still within? miller(6)->mueller(7) d=2 ok, jason->jason d=1 ok: HIT expected actually
  ])('%s %s sanity-pin', (f, l) => {
    expect(spokenNameMatchesTech(f, l, ROSTER)).not.toBeNull();
  });

  // Mills->Miller is 2 edits: INSIDE threshold, so it fires and the
  // stand-down bounds it. Pinned here so the behaviour is a decision,
  // not a surprise.
  it('Jason Mills is inside threshold and fires (bounded by stand-down)', () => {
    expect(spokenNameMatchesTech('Jason', 'Mills', ROSTER)).not.toBeNull();
  });

  it.each([
    ['Jason', 'Milton'],    // milton->miller is 3 edits, outside
    ['Jack', 'Miller'],     // jack->jason is 3 edits, outside
    ['Tom', 'Haynes'],      // tom->sam is 1 (inside) but haynes->gomez is far: joint requirement saves it
  ])('%s %s stays outside the joint threshold', (f, l) => {
    expect(spokenNameMatchesTech(f, l, ROSTER)).toBeNull();
  });
});

describe('lets ordinary callers straight through', () => {
  it.each([
    // Real customers from the call record.
    ['Kim', 'Braun'],
    ['Mark', 'Levy'],
    ['Tom', 'Haynes'],
    ['Nadia', 'Nalbandian'],
    // First name alone is a legitimate lock input and never fires the guard,
    // even when it collides with a tech's first name.
    ['Jason', ''],
    ['Ben', ''],
    // A tech's surname with a different first name is a coincidence, not a
    // transfer request.
    ['Barbara', 'Miller'],
    ['Luis', 'Gomez'],
    // Empty / junk shapes.
    ['', ''],
    ['', 'Miller'],
  ])('allows %s %s', (f, l) => {
    expect(spokenNameMatchesTech(f, l, ROSTER)).toBeNull();
  });

  it('an empty roster disables the guard entirely (fail-open)', () => {
    expect(spokenNameMatchesTech('Jason', 'Miller', [])).toBeNull();
  });
});

describe('guidance follows CVIT affirmative-only practice', () => {
  it('tells her what to do, with the transfer flow first', () => {
    expect(TECH_NAME_GUIDANCE).toMatch(/tech-status/);
    expect(TECH_NAME_GUIDANCE).toMatch(/your name/i);
    // The self-claim clause: pre-empts "no, I AM Jason Miller" confusion.
    expect(TECH_NAME_GUIDANCE).toMatch(/it is their own/);
  });
  it('contains no prohibition phrasing', () => {
    expect(TECH_NAME_GUIDANCE).not.toMatch(/\bnever\b|\bdo not\b|\bdon'?t\b/i);
  });
});
