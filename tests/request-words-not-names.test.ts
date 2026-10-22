import { isPlaceholderSpokenName } from '../src/utils/name-match';

describe('request words are not names (2026-10-22)', () => {
  test.each(['Help', 'operator', 'Person', 'REPRESENTATIVE', 'agent', 'human', 'manager', 'support', 'billing', 'sales', 'hello'])(
    '%s as a first name is refused', (w) => { expect(isPlaceholderSpokenName(w, '')).toBe(true); });
  test.each([['Tom', 'Daus'], ['Helen', 'Park'], ['Repp', 'Smith'], ['Sally', 'Agentes'], ['Bill', 'Ing']])(
    'real names still pass: %s %s', (f, l) => { expect(isPlaceholderSpokenName(f, l)).toBe(false); });
});
