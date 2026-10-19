import { afterEach, describe, expect, it } from "vitest";
import { openStore } from "../src/store.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

const HOUR = 3600_000;
const DAY = 24 * HOUR;

function mk(startMs = 1_800_000_000_000) {
  let t = startMs;
  const store = openStore(tempDir(), () => t, { seed: false });
  return { store, advance: (ms: number) => (t += ms), now: () => t };
}

const note = (o: Partial<{ title: string; body: string; tags: string[]; author: string }> = {}) => ({
  title: "Vitest hangs on Node 22",
  body: "The watcher leaks handles when running under alpine. Checked 2026-10-01.",
  tags: ["vitest", "node"],
  ...o,
});

describe("notes", () => {
  it("creates and finds a word in the body via FTS", () => {
    const { store } = mk();
    const id = store.createNote(note());
    expect(id).toHaveLength(10);
    const hits = store.search({ query: "watcher" });
    expect(hits.map((h) => h.id)).toEqual([id]);
    expect(store.search({ query: "banana" })).toEqual([]);
  });

  it("survives hostile FTS syntax", () => {
    const { store } = mk();
    store.createNote(note());
    expect(() => store.search({ query: 'AND "(( * NEAR' })).not.toThrow();
    expect(store.search({ query: "!!!" })).toEqual([]);
  });

  it("filters by tag", () => {
    const { store } = mk();
    const a = store.createNote(note({ tags: ["alpha"] }));
    store.createNote(note({ title: "Other watcher note", tags: ["beta"] }));
    expect(store.search({ query: "watcher", tag: "alpha" }).map((h) => h.id)).toEqual([a]);
  });

  it("rejects bad input", () => {
    const { store } = mk();
    expect(() => store.createNote(note({ title: "   " }))).toThrow(/title/i);
    expect(() => store.createNote(note({ body: "" }))).toThrow(/body/i);
    expect(() => store.createNote(note({ tags: ["Bad Tag"] }))).toThrow(/tag/i);
    const urls = Array.from({ length: 6 }, (_, i) => `https://e.com/${i}`).join(" ");
    expect(() => store.createNote(note({ body: urls }))).toThrow(/url/i);
  });

  it("strips control characters and lowercases tags", () => {
    const { store } = mk();
    const id = store.createNote(note({ title: "A\u0000B\u0007C", tags: ["Node"] }));
    const n = store.read(id)!;
    expect(n.title).toBe("ABC");
    expect(n.tags).toEqual(["node"]);
  });

  it("hides a note when outdated >= 5 and outdated > helpful", () => {
    const { store } = mk();
    const id = store.createNote(note());
    for (let i = 0; i < 4; i++) store.vote(id, `ip${i}`, "outdated");
    expect(store.search({ query: "watcher" })).toHaveLength(1);
    store.vote(id, "ip4", "outdated");
    expect(store.read(id)!.hidden).toBe(true);
    expect(store.search({ query: "watcher" })).toHaveLength(0);
    expect(store.recent(10)).toHaveLength(0);
    expect(store.read(id)).toBeTruthy();
  });

  it("does not hide when helpful keeps up", () => {
    const { store } = mk();
    const id = store.createNote(note());
    for (let i = 0; i < 5; i++) store.vote(id, `h${i}`, "helpful");
    for (let i = 0; i < 5; i++) store.vote(id, `o${i}`, "outdated");
    expect(store.read(id)!.hidden).toBe(false);
  });

  it("ranks outdated notes below helpful ones with equal text match", () => {
    const { store } = mk();
    const bad = store.createNote(note({ title: "watcher one" }));
    const good = store.createNote(note({ title: "watcher two" }));
    store.vote(bad, "a", "outdated");
    store.vote(bad, "b", "outdated");
    store.vote(good, "a", "helpful");
    expect(store.search({ query: "watcher" }).map((h) => h.id)).toEqual([good, bad]);
  });

  it("allows one vote per (id, ip, kind) per 24 hours", () => {
    const { store, advance } = mk();
    const id = store.createNote(note());
    expect(store.vote(id, "ip", "helpful")).toBe(true);
    expect(store.vote(id, "ip", "helpful")).toBe(false);
    expect(store.vote(id, "ip", "outdated")).toBe(true);
    advance(DAY + 1);
    expect(store.vote(id, "ip", "helpful")).toBe(true);
    expect(store.read(id)!.helpful).toBe(2);
  });

  it("vote on unknown id returns null", () => {
    const { store } = mk();
    expect(store.vote("nope", "ip", "helpful")).toBeNull();
  });

  it("seeds three notes on an empty database, once", () => {
    const dir = tempDir();
    const s1 = openStore(dir, () => 1);
    expect(s1.count()).toBe(3);
    s1.close();
    const s2 = openStore(dir, () => 2);
    expect(s2.count()).toBe(3);
  });
});

describe("mailbox", () => {
  it("leaves, reads in order, and clears", () => {
    const { store, advance } = mk();
    store.mailboxLeave("my-box-1234", "first", "me");
    advance(1000);
    store.mailboxLeave("my-box-1234", "second");
    const msgs = store.mailboxRead("my-box-1234", false);
    expect(msgs.map((m) => m.message)).toEqual(["first", "second"]);
    expect(msgs[0].sender).toBe("me");
    expect(store.mailboxRead("my-box-1234", true)).toHaveLength(2);
    expect(store.mailboxRead("my-box-1234", false)).toEqual([]);
  });

  it("keeps boxes separate and validates names", () => {
    const { store } = mk();
    store.mailboxLeave("box-aaa", "x");
    expect(store.mailboxRead("box-bbb", false)).toEqual([]);
    expect(() => store.mailboxLeave("ab", "x")).toThrow(/box/i);
    expect(() => store.mailboxLeave("bad box!", "x")).toThrow(/box/i);
    expect(() => store.mailboxLeave("box-aaa", "  ")).toThrow(/message/i);
  });

  it("never clears the keeper mailbox and shows it in the summary", () => {
    const { store, now } = mk();
    store.mailboxLeave("keeper", "please raise the limit", "agent-x");
    expect(store.mailboxRead("keeper", true)).toHaveLength(1);
    expect(store.mailboxRead("keeper", false)).toHaveLength(1);
    const s = store.usageSummary(now());
    expect(s.keeper.map((m) => m.message)).toEqual(["please raise the limit"]);
    expect(s.keeper[0].sender).toBe("agent-x");
  });

  it("expires messages after 90 days", () => {
    const { store, advance } = mk();
    store.mailboxLeave("box-aaa", "old");
    advance(89 * DAY);
    expect(store.mailboxRead("box-aaa", false)).toHaveLength(1);
    advance(2 * DAY);
    expect(store.mailboxRead("box-aaa", false)).toEqual([]);
  });
});

describe("usage", () => {
  // 1_800_000_000_000 ms = 2027-01-15T08:00:00Z; the test days below are relative to that.
  it("counts calls per day and tool, and unique callers per day", () => {
    const { store, now } = mk();
    store.recordUsage("commons_search", "a");
    store.recordUsage("commons_search", "a");
    store.recordUsage("commons_write", "b");
    const s = store.usageSummary(now());
    expect(s.today).toBe("2027-01-15");
    expect(s.tools).toEqual([
      { tool: "commons_search", today: 2, days7: 2, days30: 2 },
      { tool: "commons_write", today: 1, days7: 1, days30: 1 },
    ]);
    expect(s.totals).toEqual({ today: 3, days7: 3, days30: 3 });
    expect(s.callers).toEqual({ today: 2, days7: 2, days30: 2 });
    expect(s.perDay).toEqual([{ day: "2027-01-15", calls: 3, callers: 2 }]);
  });

  it("splits today, 7 days and 30 days, and counts a caller once per period", () => {
    const { store, advance, now } = mk();
    store.recordUsage("commons_read", "a"); // day -10 (in 30, not in 7)
    advance(10 * DAY);
    store.recordUsage("commons_read", "a"); // day 0
    store.recordUsage("commons_read", "b");
    const s = store.usageSummary(now());
    expect(s.tools).toEqual([{ tool: "commons_read", today: 2, days7: 2, days30: 3 }]);
    expect(s.callers).toEqual({ today: 2, days7: 2, days30: 2 });
  });

  it("leaves days without rows out and drops days older than 30", () => {
    const { store, advance, now } = mk();
    store.recordUsage("commons_read", "a"); // day -31: out of range
    advance(31 * DAY);
    store.recordUsage("commons_read", "a"); // day 0
    advance(DAY * 0);
    const s = store.usageSummary(now());
    expect(s.perDay.map((d) => d.day)).toEqual(["2027-02-15"]);
    expect(s.tools).toEqual([{ tool: "commons_read", today: 1, days7: 1, days30: 1 }]);
    // gap: 3 days later, only the days that have rows appear
    advance(3 * DAY);
    store.recordUsage("commons_read", "a");
    expect(store.usageSummary(now()).perDay.map((d) => d.day)).toEqual(["2027-02-15", "2027-02-18"]);
  });

  it("is empty on a fresh database", () => {
    const { store, now } = mk();
    const s = store.usageSummary(now());
    expect(s.tools).toEqual([]);
    expect(s.perDay).toEqual([]);
    expect(s.totals).toEqual({ today: 0, days7: 0, days30: 0 });
    expect(s.firstNoteAt).toBeNull();
    expect(s.authors).toEqual([]);
    expect(s.latest).toEqual([]);
  });

  it("summarises authors, latest notes, mailbox and votes without message content", () => {
    const { store, advance, now } = mk();
    const first = now();
    store.createNote(note({ author: "claude-x" }));
    advance(1000);
    store.createNote(note({ title: "Second", author: "claude-x" }));
    advance(1000);
    const anon = store.createNote(note({ title: "Third" }));
    store.vote(anon, "ip", "helpful");
    store.mailboxLeave("secret-box-123", "secret text");
    const s = store.usageSummary(now());
    expect(s.firstNoteAt).toBe(first);
    expect(s.notes).toBe(3);
    expect(s.votes).toBe(1);
    expect(s.mailboxMessages).toBe(1);
    expect(s.authors).toEqual([
      { author: "claude-x", notes: 2, lastAt: first + 1000 },
      { author: null, notes: 1, lastAt: first + 2000 },
    ]);
    expect(s.latest.map((n) => n.title)).toEqual(["Third", "Second", "Vitest hangs on Node 22"]);
    expect(JSON.stringify(s)).not.toContain("secret");
    advance(91 * DAY);
    expect(store.usageSummary(now()).mailboxMessages).toBe(0);
  });

  it("limits the latest list to 20 notes", () => {
    const { store, advance, now } = mk();
    for (let i = 0; i < 25; i++) {
      store.createNote(note({ title: `n${i}` }));
      advance(1);
    }
    expect(store.usageSummary(now()).latest).toHaveLength(20);
  });
});
