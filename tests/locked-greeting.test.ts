/**
 * What Ivy says when the lock succeeds. 2026-08-30 (Brian).
 *
 * The locked verdict shipped with no guidance field while every other verdict
 * had one, so the agent invented her own line and invented the field name:
 * "I have you locked in", 31 times in one week's 913 agent turns.
 *
 * Two rules now decide it, server-side. Never narrate the lock. Greet by name
 * only when the name is news -- 80% of locks this week were the agent repeating
 * a name the caller gave one second earlier.
 *
 * Every pair below is real: spoken names and record names from the 08-22..29
 * traffic, so this asserts the phonetic rule against what callers actually said.
 */
import { soundex, nameIsNews, LOCKED_SKIP_GUIDANCE, LOCKED_GREET_GUIDANCE } from '../src/utils/name-match';

describe('soundex', () => {
  test('classic reference values', () => {
    expect(soundex('Robert')).toBe('R163');
    expect(soundex('Rupert')).toBe('R163');
    expect(soundex('Ashcraft')).toBe('A261');   // h is transparent
    expect(soundex('Tymczak')).toBe('T522');
    expect(soundex('Pfister')).toBe('P236');
  });
  test('no letters yields empty, never a bogus code', () => {
    expect(soundex('')).toBe('');
    expect(soundex(null)).toBe('');
    expect(soundex('  42 -- ')).toBe('');
  });
});

describe('nameIsNews: the pairs that decide it', () => {
  // Inaudible differences. She would be repeating him.
  test.each([
    ['Sarah', 'Sara'],
    ['Sunshine', 'Sunshine'],
    ['Christina', 'Christina'],
    ['Tanya', 'Tanya'],
    ['Alicia', 'Alicia'],
  ])('%s heard, %s on file -> stay quiet', (heard, record) => {
    expect(nameIsNews(heard, record)).toBe(false);
  });

  // Audibly different. Saying it is how he learns where the system landed.
  test.each([
    ['Kim', 'Kimberly'],
    ['Tim', 'Kimberly'],
    ['James', 'Jim'],
    ['South', 'Sal'],
    ['Eanya', 'Tanya'],
  ])('%s heard, %s on file -> greet by name', (heard, record) => {
    expect(nameIsNews(heard, record)).toBe(true);
  });

  test('no name spoken is always news: the phone resolved them, and this is', () => {
    // ...the caller's only cue to say "actually, this is his wife."
    expect(nameIsNews('', 'Eric')).toBe(true);
    expect(nameIsNews(null, 'Susie')).toBe(true);
    expect(nameIsNews(undefined, 'Mary')).toBe(true);
  });

  test('a record with no name to say cannot be news', () => {
    expect(nameIsNews('Tom', '')).toBe(false);
    expect(nameIsNews('Tom', null)).toBe(false);
  });
});

describe('the guidance strings themselves', () => {
  test('neither one mentions the lock, the record, or the system', () => {
    for (const g of [LOCKED_SKIP_GUIDANCE, LOCKED_GREET_GUIDANCE]) {
      expect(g).not.toMatch(/lock|record|system|file|match|verif|pulled up/i);
    }
  });
  test('both point at the caller reason, which is the whole objective', () => {
    expect(LOCKED_SKIP_GUIDANCE).toMatch(/called about/);
    expect(LOCKED_GREET_GUIDANCE).toMatch(/called about/);
  });
  test('only the greet variant asks for the name', () => {
    expect(LOCKED_GREET_GUIDANCE).toMatch(/first name/i);
    expect(LOCKED_SKIP_GUIDANCE).not.toMatch(/name/i);
  });
});
