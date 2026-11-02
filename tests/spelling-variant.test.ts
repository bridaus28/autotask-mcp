/**
 * Spelling-variant first names at a verified company (2026-11-02).
 * Incident: a phone-verified residential caller said "Sherry" four times
 * against a record spelled "Sherie" and never locked (2026-10-30).
 * Guard: Tanya -> Tony (2026-06-15) must stay unlockable; soundex would pass it.
 */
import { matchSpokenName, soleCandidateLock, spellingKey } from '../src/utils/name-match';

const one = (firstName: string, extra: object = {}) =>
  [{ id: 1, firstName, lastName: 'Sample', companyID: 100, ...extra }] as any;

describe('spellingKey folds spellings of one sound only', () => {
  test.each([
    ['Sherry', 'Sherie'], ['Catherine', 'Katherine'], ['Terry', 'Teri'],
    ['Manny', 'Manii'], ['Stephen', 'Stefen'], ['Marcus', 'Markus'],
  ])('%s == %s', (a, b) => expect(spellingKey(a)).toBe(spellingKey(b)));

  test.each([
    ['Tanya', 'Tony'], ['Jon', 'Jan'], ['Tina', 'Reyna'], ['Tina', 'Team'],
    ['Sharon', 'Sherie'], ['Dana', 'Dani'], ['Jane', 'Jan'],
  ])('%s != %s', (a, b) => expect(spellingKey(a)).not.toBe(spellingKey(b)));
});

describe('S5 lifts a sole spelling variant, nothing looser', () => {
  test('Sherry locks Sherie (the incident)', () => {
    const v = matchSpokenName(one('Sherie'), 'Sherry', null);
    expect(v.status).toBe('candidates');
    expect(soleCandidateLock(v)?.id).toBe(1);
  });
  test('variant of the goes-by name also counts', () => {
    const v = matchSpokenName(one('Katherine', { middleInitial: 'Kathy' }), 'Cathie', null);
    expect(soleCandidateLock(v)?.id).toBe(1);
  });
  test('Tanya still never locks Tony', () => {
    expect(soleCandidateLock(matchSpokenName(one('Tony'), 'Tanya', null))).toBeNull();
  });
  test('Sharon does not lock Sherie', () => {
    expect(soleCandidateLock(matchSpokenName(one('Sherie'), 'Sharon', null))).toBeNull();
  });
  test('variant picks its own match out of a fuzzy crowd', () => {
    const pool = [
      { id: 1, firstName: 'Sherie', lastName: 'A', companyID: 100 },
      { id: 2, firstName: 'Shelly', lastName: 'B', companyID: 100 },
    ];
    expect(soleCandidateLock(matchSpokenName(pool as any, 'Sherry', null))?.id).toBe(1);
  });
  test('two variants tie -> not lockable', () => {
    const pool = [
      { id: 1, firstName: 'Sherie', lastName: 'A', companyID: 100 },
      { id: 2, firstName: 'Sheri', lastName: 'B', companyID: 100 },
    ];
    expect(soleCandidateLock(matchSpokenName(pool as any, 'Sherry', null))).toBeNull();
  });
  // Same policy as the exact-first Martha Garcia case: at a verified company a
  // surname miss is the wrong colleague at worst, never a stranger.
  test('surname misses: variant first name lifts like an exact one', () => {
    const v = matchSpokenName(one('Sherie'), 'Sherry', 'Nguyen');
    expect(soleCandidateLock(v)?.id).toBe(1);
  });
  test('surname misses: fuzzy non-variant still does not lift', () => {
    expect(soleCandidateLock(matchSpokenName(one('Tony'), 'Tanya', 'Smith'))).toBeNull();
  });
});
