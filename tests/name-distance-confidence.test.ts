/**
 * Distance-to-pool confidence (2026-08-15, Brian's design). ElevenLabs exposes
 * no STT confidence; the computable substitute is whether the spoken surname
 * sits a whisker outside match range of someone on file. Near-miss -> spell
 * (independent channel). Nothing close -> no re-ask; offer capture.
 * Placeholder pairs are refused only when the pool does not vouch for them.
 */
import { isNearMissSurname, nearestSurnameDistance, matchSpokenName, isPlaceholderSpokenName } from '../src/utils/name-match';

const dtc = [
  { id: 1, firstName: 'Tom', lastName: 'Daus', companyID: 1769 },
  { id: 2, firstName: 'Brian', lastName: 'Gudauskas', companyID: 1769 },
];

describe('near-miss helper (retained, UNUSED in guidance since 2026-08-16)', () => {
  // Live falsification: "Borth" flagged near-miss because it sits distance 3
  // from "Bob" - short names make everything close. The Tom-Dev protection
  // lives in S5 (exact-first sole-candidate lock), so guidance now goes
  // straight to CLEAR_NEW for every unmatched name.
  test('the helper still computes distances', () => {
    expect(nearestSurnameDistance(dtc as any, 'Eastwood')).toBeGreaterThan(4);
    expect(isNearMissSurname(dtc as any, 'Daus')).toBe(false);
  });
  test('the live false-positive: Borth vs a roster containing Bob', () => {
    const roster=[...dtc, { id: 9, firstName: 'Billy', lastName: 'Bob', companyID: 1769 }];
    expect(isNearMissSurname(roster as any, 'Borth')).toBe(true); // why it was removed
  });
});

describe('placeholder pair vs a real person on file', () => {
  const withJane = [...dtc, { id: 3, firstName: 'Jane', lastName: 'Smith', companyID: 1769 }];
  test('the pair is still flagged as a placeholder shape', () => {
    expect(isPlaceholderSpokenName('Jane', 'Smith')).toBe(true);
  });
  test('but the pool vouches: a real Jane Smith matches and can lock', () => {
    const v = matchSpokenName(withJane as any, 'Jane', 'Smith');
    expect(v.status).toBe('locked');
  });
  test('and an invented Jane Smith at a company without one matches nobody', () => {
    const v = matchSpokenName(dtc as any, 'Jane', 'Smith');
    expect(v.status).toBe('new_contact');
  });
});
