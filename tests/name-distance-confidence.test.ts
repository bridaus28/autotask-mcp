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

describe('near-miss detection', () => {
  test('Tom Dev is a near-miss of Daus (the STT garble class)', () => {
    // dev->daus distance 2, threshold(3)=1: outside match, inside near-miss
    expect(isNearMissSurname(dtc as any, 'Dev')).toBe(true);
  });
  test('Eastwood is nowhere near anyone (the genuinely-new class)', () => {
    expect(isNearMissSurname(dtc as any, 'Eastwood')).toBe(false);
    expect(nearestSurnameDistance(dtc as any, 'Eastwood')).toBeGreaterThan(4);
  });
  test('an exact match is not a near-miss (it matches)', () => {
    expect(isNearMissSurname(dtc as any, 'Daus')).toBe(false);
  });
  test('empty surname is never a near-miss', () => {
    expect(isNearMissSurname(dtc as any, '')).toBe(false);
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
