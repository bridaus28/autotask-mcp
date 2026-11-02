/**
 * Unidentified-caller clues in the closure report (2026-11-02).
 * Incident: conv_9401m6f5 (11-02) said "no record on file" for a phone on file
 * at two accounts with eight contacts.
 */
import { buildUnidentifiedCallerLines, lastSpokenName, unidentifiedCallerLines } from '../src/utils/closure-clues';

const lockCall = (p: object) => ({ tool_calls: [{ tool_name: 'autotask_lock_contact', params_as_json: JSON.stringify(p) }] });
const names = new Map([[1769, 'Daus Technologies'], [7710, 'G, Brian']]);
const twoAccounts = {
  via: 'contacts' as const, companyIds: [1769, 7710],
  pool: [
    { id: 1, firstName: 'Tom', lastName: 'Daus', companyID: 1769 },
    { id: 2, firstName: 'Mark', lastName: 'Forrester', companyID: 1769 },
    { id: 3, firstName: 'Billy', lastName: 'Bob', companyID: 1769 },
    { id: 4, firstName: 'Clint', lastName: 'Eastwood', companyID: 1769 },
    { id: 5, firstName: 'Brian', lastName: 'G', companyID: 7710 },
  ],
};

describe('lastSpokenName', () => {
  test('takes the last lock attempt, first and last', () => {
    expect(lastSpokenName([lockCall({ spoken_first: 'Sherry' }), lockCall({ spoken_first: 'Sherry', spoken_last: 'Garner' })])).toBe('Sherry Garner');
  });
  test('ignores placeholders and other tools', () => {
    const t = [lockCall({ spoken_first: 'Operator' }), { tool_calls: [{ tool_name: 'end_call', params_as_json: '{"spoken_first":"X"}' }] }];
    expect(lastSpokenName(t)).toBeNull();
  });
  test('accepts already-parsed params and survives junk', () => {
    expect(lastSpokenName([{ tool_calls: [{ tool_name: 'x_autotask_lock_contact', params_as_json: { spoken_first: 'Don' } }] }, { tool_calls: [{ tool_name: 'autotask_lock_contact', params_as_json: '{bad' }] }])).toBe('Don');
    expect(lastSpokenName(undefined)).toBeNull();
  });
});

describe('unidentifiedCallerLines', () => {
  test('multi-account phone lists accounts and capped names (the 11-02 test call)', () => {
    expect(unidentifiedCallerLines('Don', twoAccounts, names, '+15085910828')).toEqual([
      'Caller: Unidentified',
      'Name given on call: Don',
      'Phone on file at 2 accounts:',
      '  - Daus Technologies: Tom Daus, Mark Forrester, Billy Bob (+1 more)',
      '  - G, Brian: Brian G',
    ]);
  });
  test('company main line', () => {
    const acct = { via: 'company_main_phone' as const, companyIds: [42], pool: [] };
    expect(unidentifiedCallerLines(null, acct, new Map([[42, 'Acme Corp']]), '+1')).toEqual(['Caller: Unidentified', 'Phone matches the main number of Acme Corp']);
  });
  test('no match keeps the old wording, now true', () => {
    expect(unidentifiedCallerLines(null, { via: 'none', companyIds: [], pool: [] }, new Map(), '+15550001111'))
      .toEqual(['Caller: Unidentified', 'Phone: no record on file for +15550001111']);
  });
  test('caps accounts at five', () => {
    const ids = [1, 2, 3, 4, 5, 6, 7];
    const lines = unidentifiedCallerLines(null, { via: 'contacts', companyIds: ids, pool: [] }, new Map(), '+1');
    expect(lines.filter(l => l.startsWith('  - ')).length).toBe(6);
    expect(lines[lines.length - 1]).toBe('  - (+2 more accounts)');
  });
});

describe('buildUnidentifiedCallerLines', () => {
  test('lookup error falls back to the old line', async () => {
    const lines = await buildUnidentifiedCallerLines(async () => { throw new Error('down'); }, async () => null, '+15085910828', []);
    expect(lines).toEqual(['Caller: Unidentified (no record on file for +15085910828)']);
  });
  test('company-name error falls back to the id label, not the whole block', async () => {
    const lines = await buildUnidentifiedCallerLines(async () => twoAccounts, async () => { throw new Error('x'); }, '+1', []);
    expect(lines).toContain('  - company 7710: Brian G');
  });
  test('unknown phone skips the lookup', async () => {
    let called = false;
    const lines = await buildUnidentifiedCallerLines(async () => { called = true; return twoAccounts; }, async () => null, 'Unknown', [lockCall({ spoken_first: 'Don' })]);
    expect(called).toBe(false);
    expect(lines).toEqual(['Caller: Unidentified', 'Name given on call: Don']);
  });
});
