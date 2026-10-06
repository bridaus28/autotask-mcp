import { closureSummary } from '../src/utils/closure-summary';

describe('closureSummary', () => {
  test('our call_summary wins over the vendor summary', () => {
    expect(closureSummary({
      transcript_summary: 'The caller misidentified herself.',
      data_collection_results: { call_summary: { value: 'Ivy misheard a request for a technician as the caller\'s name.' } },
    })).toMatch(/^Ivy misheard/);
  });
  test.each([[undefined], [null], [''], ['   '], ['None']])('empty ours (%p) falls back to the vendor summary', (v) => {
    expect(closureSummary({ transcript_summary: 'Vendor text.', data_collection_results: { call_summary: { value: v } } })).toBe('Vendor text.');
  });
  test('no field at all, or no analysis: still a line', () => {
    expect(closureSummary({ transcript_summary: 'Vendor text.' })).toBe('Vendor text.');
    expect(closureSummary(undefined)).toBe('No summary available.');
  });
});
