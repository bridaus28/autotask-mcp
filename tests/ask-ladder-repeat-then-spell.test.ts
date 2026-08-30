/**
 * Ask ladder: repeat once, then spell, then settle. 2026-08-30 (Brian).
 *
 * Why: Kim arrived as "Tim" and Zandra as "Angela" on 08-27/28. The record was
 * right both times and the surname carried the lock, but where the surname
 * cannot carry it the caller used to be sent straight to spelling on the first
 * failure. A receptionist asks once first. Spelling stays the channel that adds
 * signal (08-15); it just arrives second.
 *
 * The tier is counted per CALLER, not per spoken token, because a second
 * mangling produces a different token -- a token-keyed counter reads zero and
 * asks again, which is the S4 Covina loop ("I wanna strangle this lady")
 * rebuilt sideways.
 */
jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no live API in tests')) }
}));

import {
  askTier,
  REPEAT_SURNAME_GUIDANCE, REPEAT_FIRST_GUIDANCE,
  NEAR_MISS_GUIDANCE, FIRST_NEAR_MISS_GUIDANCE,
  CANDIDATES_REPEAT_GUIDANCE, CANDIDATES_SPELL_GUIDANCE,
} from '../src/mcp/server';
import { RepeatedLockAttempts } from '../src/utils/name-match';

describe('askTier', () => {
  test('first failure asks for a repeat', () => {
    expect(askTier(0, 0)).toBe('repeat');
  });
  test('second failure escalates to spelling', () => {
    expect(askTier(1, 0)).toBe('spell');
  });
  test('two asks is the cap - a third failure settles', () => {
    expect(askTier(2, 0)).toBe('settled');
    expect(askTier(7, 0)).toBe('settled');
  });
  test('an identical retry settles immediately, never re-asks (S4)', () => {
    expect(askTier(0, 1)).toBe('settled');
    expect(askTier(1, 3)).toBe('settled');
  });
});

describe('ask ladder is counted per caller, not per spoken token', () => {
  // The regression this exists to prevent: "Kim" -> "Tim" -> "Kem" are three
  // different tokens from one caller. Keyed on tokens, each reads as a first
  // failure and she asks forever.
  test('three different manglings from one caller still cap at two asks', () => {
    const ladder = new RepeatedLockAttempts();
    const key = RepeatedLockAttempts.key('+19095551212', 668, '', '');
    const tiers = ['Tim', 'Kem', 'Kim'].map(() => askTier(ladder.countAndRecord(key), 0));
    expect(tiers).toEqual(['repeat', 'spell', 'settled']);
  });

  test('a different caller starts its own ladder', () => {
    const ladder = new RepeatedLockAttempts();
    const a = RepeatedLockAttempts.key('+19095551212', 668, '', '');
    const b = RepeatedLockAttempts.key('+16265559999', 668, '', '');
    ladder.countAndRecord(a); ladder.countAndRecord(a);
    expect(askTier(ladder.countAndRecord(b), 0)).toBe('repeat');
  });

  test('the token-keyed counter is untouched by the ask ladder', () => {
    // S4 still needs to see byte-identical retries; the two counters are separate.
    const tokens = new RepeatedLockAttempts();
    const k = RepeatedLockAttempts.key('+19095551212', 668, 'Tim', 'Braus');
    expect(tokens.countAndRecord(k)).toBe(0);
    expect(tokens.countAndRecord(k)).toBe(1);
  });
});

describe('guidance wording', () => {
  test('repeat rung asks the caller to say it again, never to spell', () => {
    for (const g of [REPEAT_SURNAME_GUIDANCE, REPEAT_FIRST_GUIDANCE, CANDIDATES_REPEAT_GUIDANCE]) {
      expect(g.toLowerCase()).toContain('again');
      expect(g.toLowerCase()).not.toContain('spell');
    }
  });
  test('spell rung is still the spelling ask', () => {
    for (const g of [NEAR_MISS_GUIDANCE, FIRST_NEAR_MISS_GUIDANCE, CANDIDATES_SPELL_GUIDANCE]) {
      expect(g.toLowerCase()).toContain('spell');
    }
  });
  test('repeat rung blames the transcription, not the caller', () => {
    expect(REPEAT_SURNAME_GUIDANCE).toContain('transcription is as likely at fault');
    expect(CANDIDATES_REPEAT_GUIDANCE).toContain('transcription is as likely at fault');
  });
  test('names on file stay internal on every rung that names a person', () => {
    for (const g of [REPEAT_SURNAME_GUIDANCE, REPEAT_FIRST_GUIDANCE]) {
      expect(g).toContain('names on file stay internal');
      expect(g.toLowerCase()).toContain('only after it is confirmed');
    }
  });
});

describe('ladder window is deliberately short', () => {
  // Two people can call from one number back to back. There is no call id on
  // this endpoint, so the window is the only guard; the second caller must not
  // inherit the first caller's rung.
  test('the ladder expires well inside a call gap', async () => {
    const ladder = new RepeatedLockAttempts(60);
    const key = RepeatedLockAttempts.key('+19095551212', 668, '', '');
    expect(askTier(ladder.countAndRecord(key), 0)).toBe('repeat');
    expect(askTier(ladder.countAndRecord(key), 0)).toBe('spell');
    await new Promise(r => setTimeout(r, 80));
    // A later caller on the same number starts clean rather than at 'settled'.
    expect(askTier(ladder.countAndRecord(key), 0)).toBe('repeat');
  });
});
