/**
 * Phone tiebreak among same-name candidates (2026-10-06).
 * Synthetic names and numbers only (public repo).
 */
import { matchSpokenName, phoneTiebreak, phoneKey, PoolContact } from '../src/utils/name-match';

const CALLER = '+19095550142';
const pool = (a: Partial<any>, b: Partial<any>, extra: any[] = []): PoolContact[] => [
  { id: 1, firstName: 'Dana', lastName: 'Quill', ...a } as any,
  { id: 2, firstName: 'Dana', lastName: 'Quill', ...b } as any,
  ...extra,
];

describe('phoneKey', () => {
  test.each([
    ['+19095550142', '9095550142'],
    ['(909) 555-0142', '9095550142'],
    ['909.555.0142', '9095550142'],
  ])('%s', (input, expected) => {
    expect(phoneKey(input)).toBe(expected);
  });
  test('Unknown, blank, short never produce a key', () => {
    for (const v of ['Unknown', '', null, undefined, '555-0142']) expect(phoneKey(v as any)).toBe('');
  });
});

describe('phoneTiebreak', () => {
  test('two same-name records, one carries the calling phone: that one', () => {
    const v = matchSpokenName(pool({ phone: '(909) 555-0142' }, { phone: 'Unknown' }), 'Dana', 'Quill');
    expect(v.status).toBe('candidates');
    expect(phoneTiebreak(v, CALLER)?.id).toBe(1);
  });
  test('match on mobile or alternate phone counts', () => {
    const v1 = matchSpokenName(pool({ mobilePhone: '909.555.0142' }, {}), 'Dana', 'Quill');
    expect(phoneTiebreak(v1, CALLER)?.id).toBe(1);
    const v2 = matchSpokenName(pool({}, { alternatePhone: '9095550142' }), 'Dana', 'Quill');
    expect(phoneTiebreak(v2, CALLER)?.id).toBe(2);
  });
  test('neither carries the phone: no tiebreak', () => {
    const v = matchSpokenName(pool({ phone: '9095559999' }, { phone: '' }), 'Dana', 'Quill');
    expect(phoneTiebreak(v, CALLER)).toBeNull();
  });
  test('both carry it (shared office line): no tiebreak', () => {
    const v = matchSpokenName(pool({ phone: '9095550142' }, { phone: '+1 909 555 0142' }), 'Dana', 'Quill');
    expect(phoneTiebreak(v, CALLER)).toBeNull();
  });
  test('the phone never adds someone the name did not match', () => {
    const p = pool({}, {}, [{ id: 3, firstName: 'Morgan', lastName: 'Vale', phone: '9095550142' }]);
    const v = matchSpokenName(p, 'Dana', 'Quill');
    expect(phoneTiebreak(v, CALLER)).toBeNull();
  });
  test('first name only, two exact first names, one has the phone', () => {
    const p: PoolContact[] = [
      { id: 1, firstName: 'Dana', lastName: 'Quill', phone: '9095550142' } as any,
      { id: 2, firstName: 'Dana', lastName: 'Ortiz' } as any,
    ];
    const v = matchSpokenName(p, 'Dana', '');
    expect(v.status).toBe('candidates');
    expect(phoneTiebreak(v, CALLER)?.id).toBe(1);
  });
  test('no caller phone, or Unknown: no tiebreak', () => {
    const v = matchSpokenName(pool({ phone: '9095550142' }, {}), 'Dana', 'Quill');
    expect(phoneTiebreak(v, '')).toBeNull();
    expect(phoneTiebreak(v, 'Unknown')).toBeNull();
  });
  test('not a multi-candidate verdict: no tiebreak', () => {
    const locked = matchSpokenName([{ id: 9, firstName: 'Dana', lastName: 'Quill', phone: '9095550142' } as any], 'Dana', 'Quill');
    expect(phoneTiebreak(locked, CALLER)).toBeNull();
  });
});
