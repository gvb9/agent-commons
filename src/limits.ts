import type { Database } from "better-sqlite3";

export type Bucket = "write" | "read";

// Per IP per hour. Writes: write, vote, mailbox_leave. Reads: everything else.
const MAX: Record<Bucket, number> = { write: 30, read: 600 };
const WINDOW_MS = 3600_000;

export interface LimitResult {
  ok: boolean;
  retryAfterSec: number;
}

/** Fixed-window rate limiter stored in the `ratelimit` table. No timers: stale rows are pruned on use. */
export class RateLimiter {
  constructor(
    private db: Database,
    private now: () => number,
  ) {}

  check(ipHash: string, bucket: Bucket): LimitResult {
    const now = this.now();
    const windowStart = now - (now % WINDOW_MS);
    return this.db.transaction((): LimitResult => {
      this.db.prepare("DELETE FROM ratelimit WHERE window_start < ?").run(windowStart);
      const row = this.db
        .prepare("SELECT window_start, count FROM ratelimit WHERE ip_hash = ? AND bucket = ?")
        .get(ipHash, bucket) as { window_start: number; count: number } | undefined;
      const count = row && row.window_start === windowStart ? row.count : 0;
      if (count >= MAX[bucket]) {
        return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000)) };
      }
      this.db
        .prepare(
          `INSERT INTO ratelimit (ip_hash, bucket, window_start, count) VALUES (?, ?, ?, 1)
           ON CONFLICT (ip_hash, bucket) DO UPDATE SET window_start = excluded.window_start, count = ? `,
        )
        .run(ipHash, bucket, windowStart, count + 1);
      return { ok: true, retryAfterSec: 0 };
    })();
  }
}
