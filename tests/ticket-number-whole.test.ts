/**
 * A ticket lookup takes the whole number. 2026-08-31 (Brian).
 *
 * autotask_search_tickets did beginsWith on ticketNumber with no company
 * filter, so "T20260831" returned every ticket created that day across the
 * tenant. On 2026-08-31 13:09 (conv ...q04v34ae) a caller who never identified
 * himself said "Ticket T20260831." and got 25 rows; 20 seconds later a note for
 * his own ticket also landed on the first row of that list, which belonged to
 * another customer.
 *
 * Every searchTerm below is real, taken from the 2,058 conversations on disk.
 */
import { normalizeTicketNumber, PARTIAL_TICKET_GUIDANCE } from '../src/utils/name-match';

describe('whole ticket numbers are accepted', () => {
  test.each([
    ['T20260831.0026', 'T20260831.0026'],
    ['T20260828.0027', 'T20260828.0027'],
    ['t20260511.0088', 'T20260511.0088'],
    ['T20260831.0026 ', 'T20260831.0026'],
    // The caller's punctuation does not survive speech. Seen twice in the
    // corpus; today beginsWith cannot match a stored "T20260609.0005" and the
    // search silently returns nothing.
    ['T202606090005', 'T20260609.0005'],
    ['20260609 0005', 'T20260609.0005'],
    ['T20260609-0005', 'T20260609.0005'],
  ])('%s normalises to %s', (spoken, expected) => {
    expect(normalizeTicketNumber(spoken)).toBe(expected);
  });
});

describe('anything short of a whole number is refused', () => {
  // Every one of these was really passed as searchTerm at some point.
  test.each([
    'T20260831',      // the incident
    'T20260716', 'T20260423', 'T20260515', 'T20260511', 'T20260512',
    'T202605', 'T20260', 'T20268', 'T504', 'T',
    'T20260624.00',   // partial sequence still enumerates
    'payment', 'Mitel', '7047280', 'T5047202006',
  ])('%s is not a whole ticket number', (spoken) => {
    expect(normalizeTicketNumber(spoken)).toBeNull();
  });

  test('empty and absent input never look like a lookup', () => {
    expect(normalizeTicketNumber('')).toBeNull();
    expect(normalizeTicketNumber('   ')).toBeNull();
    expect(normalizeTicketNumber(null)).toBeNull();
    expect(normalizeTicketNumber(undefined)).toBeNull();
  });

  test('a date prefix cannot be widened into a match by padding', () => {
    // The failure mode to protect: any input that would still beginsWith many
    // tickets must not survive normalisation.
    for (const s of ['T2026083', 'T20260831.', 'T20260831.0', 'T20260831.00', 'T20260831.000']) {
      expect(normalizeTicketNumber(s)).toBeNull();
    }
  });
});

describe('the refusal guidance', () => {
  test('says what to ask for and that nothing was read', () => {
    expect(PARTIAL_TICKET_GUIDANCE).toMatch(/whole number/i);
    expect(PARTIAL_TICKET_GUIDANCE).toMatch(/four digits/i);
    expect(PARTIAL_TICKET_GUIDANCE).toMatch(/nothing was looked up/i);
  });
  test('affirmative-only, per house style', () => {
    expect(PARTIAL_TICKET_GUIDANCE).not.toMatch(/\bdo not\b|\bdon'?t\b|\bcannot\b|\bnever\b/i);
  });
  test('names no ticket, company or contact', () => {
    expect(PARTIAL_TICKET_GUIDANCE).not.toMatch(/T\d{8}/);
  });
});
