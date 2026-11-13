/**
 * Status page outage notice (2026-11-13). Fixtures are the live CV Services
 * Status RSS shape captured 2026-11-12 during the Microsoft 365 outage.
 */
import {
  affectedComponents, noticeText, getStatusNotice, resetStatusNoticeCache, CACHE_MS,
} from '../src/utils/status-notice';

const item = (name: string, status: string) =>
  `<item><title>${name} - ${status}</title><pubDate>Thu, 12 Nov 2026 10:08:26 -0800</pubDate>` +
  `<description>${name} is ${status}</description><guid isPermaLink="false">x</guid></item>`;
const feed = (...items: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>CV Services Status - Status</title>${items.join('')}</channel></rss>`;

describe('affectedComponents', () => {
  test('all operational -> none', () => {
    expect(affectedComponents(feed(item('Email Protection', 'Operational'), item('Password Portal', 'Operational')))).toEqual([]);
  });
  test('2026-11-12 shape: manual Major Outage plus automated Degraded', () => {
    const xml = feed(
      item('Microsoft 365', 'Major Outage'),
      item('Backup Services - Cloud1', 'Operational'),
      item('Microsoft 365 - Service Status', 'Degraded Performance'),
    );
    expect(affectedComponents(xml)).toEqual(['Microsoft 365', 'Microsoft 365 - Service Status']);
  });
  test('maintenance and informational are not spoken', () => {
    expect(affectedComponents(feed(item('Hosted Applications', 'Under Maintenance'), item('Ticket System V2', 'Informational')))).toEqual([]);
  });
  test('partial outage counts; duplicate names collapse', () => {
    expect(affectedComponents(feed(item('Website - computervillage.com', 'Partial Outage'), item('Website - computervillage.com', 'Partial Outage'))))
      .toEqual(['Website - computervillage.com']);
  });
  test('XML entities decode', () => {
    expect(affectedComponents(feed(item('R&amp;D Portal', 'Major Outage')))).toEqual(['R&D Portal']);
  });
  test('garbage input -> none', () => {
    expect(affectedComponents('not xml')).toEqual([]);
  });
});

describe('noticeText', () => {
  test('empty when clear', () => expect(noticeText([])).toBe(''));
  test('one component', () => {
    expect(noticeText(['Microsoft 365'])).toBe('Please note, our status page shows an issue with Microsoft 365 right now.');
  });
  test('two and three components join naturally', () => {
    expect(noticeText(['A', 'B'])).toContain('issue with A and B right now.');
    expect(noticeText(['A', 'B', 'C'])).toContain('issue with A, B and C right now.');
  });
});

describe('getStatusNotice: fail-safe and cached', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; resetStatusNoticeCache(); });

  test('outage in feed -> spoken line', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => feed(item('Microsoft 365', 'Major Outage')) }) as any;
    expect(await getStatusNotice('u', 1000)).toContain('Microsoft 365');
  });
  test('network error -> empty, never throws', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('down')) as any;
    await expect(getStatusNotice('u', 1000)).resolves.toBe('');
  });
  test('HTTP error -> empty', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, text: async () => '' }) as any;
    expect(await getStatusNotice('u', 1000)).toBe('');
  });
  test('cached within window, refetched after', async () => {
    const f = jest.fn()
      .mockResolvedValueOnce({ ok: true, text: async () => feed(item('Microsoft 365', 'Major Outage')) })
      .mockResolvedValueOnce({ ok: true, text: async () => feed(item('Microsoft 365', 'Operational')) });
    global.fetch = f as any;
    expect(await getStatusNotice('u', 1000)).not.toBe('');
    expect(await getStatusNotice('u', 1000 + CACHE_MS - 1)).not.toBe('');
    expect(f).toHaveBeenCalledTimes(1);
    expect(await getStatusNotice('u', 1000 + CACHE_MS)).toBe('');
    expect(f).toHaveBeenCalledTimes(2);
  });
});
