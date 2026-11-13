/**
 * Status page outage notice for Ivy (2026-11-13).
 *
 * On 2026-11-12 a Microsoft 365 outage drove 24 of Ivy's 35 calls, and staff
 * hand-typed the outage into her greeting (then had to remember to take it out).
 * This reads the public CV Services Status RSS (Site24x7 StatusIQ) and returns
 * one spoken line when any component shows an outage status, or '' when all
 * are clear. /business-status carries it to the Twilio call-init function,
 * which passes it to ElevenLabs as the status_notice dynamic variable.
 *
 * Fail-safe: any fetch or parse problem returns '', which is the pre-change
 * behavior. On the pre-speech path, so the fetch is bounded and cached.
 */

export const DEFAULT_STATUS_RSS_URL = 'https://computervillage.site24x7statusiq.com/rss';
export const CACHE_MS = 2 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 1500;

// Only real problems are spoken. Operational, Informational and Under
// Maintenance are not an "issue" a caller should hear about.
export const OUTAGE_STATUSES = new Set(['Degraded Performance', 'Partial Outage', 'Major Outage']);

/** Component names whose RSS item shows an outage status, unique, in feed order. */
export function affectedComponents(rssXml: string): string[] {
  const names: string[] = [];
  const items = rssXml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const item of items) {
    // StatusIQ puts "<component> is <status>" in each item's description.
    const desc = item.match(/<description>([\s\S]*?)<\/description>/)?.[1]?.trim() ?? '';
    const m = desc.match(/^(.*) is (.+)$/);
    if (!m) continue;
    const name = decodeXml(m[1].trim());
    const status = m[2].trim();
    if (OUTAGE_STATUSES.has(status) && name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The line Ivy speaks, or '' when nothing is affected. */
export function noticeText(names: string[]): string {
  if (names.length === 0) return '';
  const list = names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Please note, our status page shows an issue with ${list} right now.`;
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

let cache: { at: number; text: string } | null = null;

/** Cached status notice. Never throws; '' on any failure. */
export async function getStatusNotice(
  url: string = process.env.STATUS_PAGE_RSS_URL || DEFAULT_STATUS_RSS_URL,
  now: number = Date.now(),
): Promise<string> {
  if (cache && now - cache.at < CACHE_MS) return cache.text;
  let text = '';
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (res.ok) text = noticeText(affectedComponents(await res.text()));
  } catch {
    text = '';
  }
  cache = { at: now, text };
  return text;
}

/** Test hook. */
export function resetStatusNoticeCache(): void {
  cache = null;
}
