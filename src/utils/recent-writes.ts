// ─── Idempotent create replay (2026-08-15) ───────────────────────────────────
// An abandoned tool result does not mean the write did not happen. Measured:
// companies 6870/6871 ("Ricela") created 2 seconds apart on 2026-08-06 after
// "Tool execution was abandoned due to user input"; two byte-identical
// create_contact calls in one call on 2026-08-11 (Daniel Amini). The model
// retries what it believes failed, and the retry writes a duplicate.
//
// This is a per-process short-window memo, not a database: identical create
// parameters seen within TTL return the FIRST result and write nothing.
// Restarts lose it, which is fine -- the retry pattern is seconds apart, in
// one conversation, on one instance.

export interface ToolOutcome { result: unknown; message: string }

interface Entry { ts: number; result: ToolOutcome }

export class RecentWrites {
  private seen = new Map<string, Entry>();
  constructor(private ttlMs = 180_000, private maxEntries = 500) {}

  /** Stable key from the identity-bearing fields of a create. */
  static key(kind: string, fields: Record<string, unknown>): string {
    const norm = Object.keys(fields).sort().map(k =>
      `${k}=${String(fields[k] ?? '').toLowerCase().replace(/\s+/g, ' ').trim()}`);
    return `${kind}|${norm.join('|')}`;
  }

  /** Returns the earlier result when this exact create ran within the TTL. */
  check(key: string): ToolOutcome | undefined {
    const e = this.seen.get(key);
    if (!e) return undefined;
    if (Date.now() - e.ts > this.ttlMs) { this.seen.delete(key); return undefined; }
    return e.result;
  }

  record(key: string, result: ToolOutcome): void {
    if (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.set(key, { ts: Date.now(), result });
  }
}
