import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "../src/store.js";
import { RateLimiter } from "../src/limits.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

const HOUR = 3600_000;

function mk() {
  let t = 1_800_000_000_000; // exactly on an hour boundary
  t -= t % HOUR;
  const store = openStore(tempDir(), () => t, { seed: false });
  return { limiter: new RateLimiter(store.db, () => t), advance: (ms: number) => (t += ms) };
}

describe("rate limiter", () => {
  it("blocks the 31st write in an hour and allows the next hour again", () => {
    const { limiter, advance } = mk();
    for (let i = 0; i < 30; i++) expect(limiter.check("ip", "write").ok).toBe(true);
    const blocked = limiter.check("ip", "write");
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(3600);
    advance(HOUR);
    expect(limiter.check("ip", "write").ok).toBe(true);
  });

  it("counts buckets and IPs separately; reads allow 600", () => {
    const { limiter } = mk();
    for (let i = 0; i < 30; i++) limiter.check("a", "write");
    expect(limiter.check("b", "write").ok).toBe(true);
    expect(limiter.check("a", "read").ok).toBe(true);
    for (let i = 0; i < 600; i++) limiter.check("c", "read");
    expect(limiter.check("c", "read").ok).toBe(false);
  });
});
