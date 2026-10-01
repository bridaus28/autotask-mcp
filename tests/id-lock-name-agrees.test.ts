/**
 * A contact_id lock must agree with the name the caller gave (2026-09-30).
 *
 * conv_4001m3dcbaede4rvxjnnybgfq2p9, 09-25: "Rebecca", unknown phone, unknown
 * company, was locked by contact_id as "Billy Bob" at a different company and
 * read that company's open ticket. The id path corroborated nothing. The
 * check that refuses it is the greeting's comparator: does the record's first
 * name sound like the one she heard. Phone data is deliberately not consulted.
 */
import { idLockNameAgrees, ID_LOCK_NAME_REQUIRED_GUIDANCE, ID_LOCK_NAME_MISMATCH_GUIDANCE } from '../src/utils/name-match';

describe('idLockNameAgrees', () => {
  test('the 09-25 call: Rebecca is not Billy', () => {
    expect(idLockNameAgrees('Rebecca', 'Billy', null)).toBe(false);
  });
  test.each([
    ['Sarah', 'Sara', null],
    ['Robert', 'Robert', null],
    ['Jon', 'John', null],
  ])('%s heard, %s on file -> agrees (inaudible spelling differences)', (heard, record, goesBy) => {
    expect(idLockNameAgrees(heard, record, goesBy)).toBe(true);
  });
  test('known edge: soundex keeps the first letter, so Katherine/Catherine refuses', () => {
    // Fail-safe direction. The agent falls back to the spoken-name path,
    // which has its own fuzzy matching; nothing is exposed, one more turn.
    expect(idLockNameAgrees('Katherine', 'Catherine', null)).toBe(false);
  });
  test('goes-by name counts: "Bill" heard, record William goes by Bill', () => {
    expect(idLockNameAgrees('Bill', 'William', 'Bill')).toBe(true);
    expect(idLockNameAgrees('Bill', 'William', null)).toBe(false);
  });
  test('no spoken name is never agreement', () => {
    expect(idLockNameAgrees('', 'Billy', null)).toBe(false);
    expect(idLockNameAgrees(null, 'Billy', null)).toBe(false);
  });
  test('the ambiguous_company cure still works: same person, picked by id', () => {
    // The id path exists so the agent can pick one of several records for
    // the same caller across companies. The caller said their own name.
    expect(idLockNameAgrees('Tina', 'Tina', null)).toBe(true);
  });
});

describe('guidance strings', () => {
  test('both are affirmative and neither names the record', () => {
    for (const g of [ID_LOCK_NAME_REQUIRED_GUIDANCE, ID_LOCK_NAME_MISMATCH_GUIDANCE]) {
      expect(g).not.toMatch(/\bdo not\b|\bdon'?t\b/i);
      expect(g).not.toMatch(/Billy|Bob/);
    }
    expect(ID_LOCK_NAME_REQUIRED_GUIDANCE).toMatch(/spoken_first/);
  });
});
