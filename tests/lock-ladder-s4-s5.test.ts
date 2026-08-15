/**
 * S4 (no-repeat retry) + S5 (sole-candidate lock) on the name matcher and its
 * policy helpers. 2026-08-15. Fixtures are the real incidents:
 *
 *  - Covina Valley / Garcia: candidates(1) at a phone-verified company, four
 *    lock attempts, 175s + 247s calls, never locked. (BUGS_2026-08-13 #1)
 *  - Tom Daus heard as "Tom Dev": surname unrecoverable, unique exact first.
 *  - Tanya -> Tony Whetstone (2026-06-15): fuzzy first MUST NOT lock, ever.
 *  - conv_8101 sent byte-identical params three times; the guidance instructed
 *    a retry that could not converge.
 */
import {
  matchSpokenName, soleCandidateLock, RepeatedLockAttempts,
  REPEAT_CANDIDATES_GUIDANCE, REPEAT_NEW_CONTACT_GUIDANCE,
} from '../src/utils/name-match';

const covina = [
  { id: 1, firstName: 'Martha', lastName: 'Okonkwo', companyID: 6433 },
  { id: 2, firstName: 'Robert', lastName: 'Kim', companyID: 6433 },
];
const daus = [
  { id: 10, firstName: 'Tom', lastName: 'Daus', companyID: 1769 },
  { id: 11, firstName: 'Brian', lastName: 'Gudauskas', companyID: 1769 },
];
const whetstone = [
  { id: 20, firstName: 'Tony', lastName: 'Whetstone', companyID: 594 },
];

describe('S5 sole-candidate lock', () => {
  test('unique exact first + unmatchable surname -> lockable (the Garcia loop)', () => {
    const v = matchSpokenName(covina as any, 'Martha', 'Garcia');
    expect(v.status).toBe('candidates');
    const sole = soleCandidateLock(v);
    expect(sole).not.toBeNull();
    expect(sole!.id).toBe(1);
  });
  test('Tom Dev still finds Tom Daus', () => {
    const v = matchSpokenName(daus as any, 'Tom', 'Dev');
    const sole = soleCandidateLock(v);
    expect(sole).not.toBeNull();
    expect(sole!.id).toBe(10);
  });
  test('fuzzy first name NEVER lockable (Tanya -> Tony)', () => {
    const v = matchSpokenName(whetstone as any, 'Tanya', null);
    expect(v.status).toBe('candidates');
    expect(soleCandidateLock(v)).toBeNull();
  });
  test('fuzzy first with contradicting surname NEVER lockable', () => {
    const v = matchSpokenName(whetstone as any, 'Tanya', 'Smith');
    expect(soleCandidateLock(v)).toBeNull();
  });
  test('two candidates -> not lockable', () => {
    const pool = [...covina, { id: 3, firstName: 'Martha', lastName: 'Lopez', companyID: 6433 }];
    const v = matchSpokenName(pool as any, 'Martha', 'Garcia');
    expect(soleCandidateLock(v)).toBeNull();
  });
  test('unchanged: unique surname match still locks directly', () => {
    const v = matchSpokenName(daus as any, 'Tom', 'Douse');
    expect(v.status).toBe('locked');
  });
  test('unchanged: no-name call is not lockable', () => {
    const v = matchSpokenName(whetstone as any, null, null);
    expect(soleCandidateLock(v)).toBeNull();
  });
});

describe('S4 repeated identical attempts', () => {
  test('first attempt is 0 priors, identical retry counts up', () => {
    const r = new RepeatedLockAttempts();
    const k = RepeatedLockAttempts.key('+19095551212', 6433, 'Martha', 'Garcia');
    expect(r.countAndRecord(k)).toBe(0);
    expect(r.countAndRecord(k)).toBe(1);
    expect(r.countAndRecord(k)).toBe(2);
  });
  test('changed input is a fresh attempt', () => {
    const r = new RepeatedLockAttempts();
    expect(r.countAndRecord(RepeatedLockAttempts.key('+1', 6433, 'Martha', 'Garcia'))).toBe(0);
    expect(r.countAndRecord(RepeatedLockAttempts.key('+1', 6433, 'Martha', 'Garcia Lopez'))).toBe(0);
  });
  test('key normalizes case and whitespace (STT jitter is not a new attempt)', () => {
    const a = RepeatedLockAttempts.key('+1', 6433, 'Martha', 'garcia');
    const b = RepeatedLockAttempts.key('+1', 6433, ' MARTHA ', 'Garcia');
    expect(a).toBe(b);
  });
  test('decision guidance never instructs another ask', () => {
    for (const g of [REPEAT_CANDIDATES_GUIDANCE, REPEAT_NEW_CONTACT_GUIDANCE]) {
      expect(g.toLowerCase()).not.toContain('spell');
      expect(g.toLowerCase()).not.toContain('lock again');
      expect(g.toLowerCase()).not.toContain('call again');
      expect(g.toLowerCase()).not.toContain('ask');
      expect(g.toLowerCase()).not.toContain('not found');
    }
  });
});
