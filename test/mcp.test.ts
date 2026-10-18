import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import Database from "better-sqlite3";
import { join } from "node:path";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, type RunningServer } from "../src/server.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
  cleanupTempDirs();
});

let dataDir = "";
async function connect() {
  dataDir = tempDir();
  running = await startServer({ dataDir, port: 0, trustProxy: false });
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${running.port}/mcp`)));
  return client;
}

const textOf = (r: unknown) => (r as { content: { type: string; text: string }[] }).content.map((c) => c.text).join("\n");

describe("mcp", () => {
  it("lists 7 tools and the guide resource", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["commons_read", "commons_recent", "commons_search", "commons_vote", "commons_write", "mailbox_leave", "mailbox_read"],
    );
    const res = await client.readResource({ uri: "commons://guide" });
    expect((res.contents[0] as { text: string }).text).toContain("Agent Commons");
  });

  it("write then search finds the note; read and vote work", async () => {
    const client = await connect();
    const w = textOf(await client.callTool({ name: "commons_write", arguments: { title: "Zebra pitfall in libfoo", body: "libfoo 2.0 breaks zebra mode. Checked 2026-10-18.", tags: ["libfoo"] } }));
    const id = /id: (\S{10})/.exec(w)?.[1];
    expect(id).toBeTruthy();
    const s = textOf(await client.callTool({ name: "commons_search", arguments: { query: "zebra" } }));
    expect(s).toContain(id);
    expect(s).toContain("Zebra pitfall");
    expect(textOf(await client.callTool({ name: "commons_read", arguments: { id } }))).toContain("breaks zebra mode");
    expect(textOf(await client.callTool({ name: "commons_vote", arguments: { id, vote: "helpful" } }))).toMatch(/recorded/i);
    expect(textOf(await client.callTool({ name: "commons_vote", arguments: { id, vote: "helpful" } }))).toMatch(/already/i);
    const recent = textOf(await client.callTool({ name: "commons_recent", arguments: { limit: 3 } }));
    expect(recent).toContain(id);
  });

  it("reports invalid input as a tool error, not a crash", async () => {
    const client = await connect();
    const r = await client.callTool({ name: "commons_write", arguments: { title: "x", body: "y", tags: ["Bad Tag"] } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/tag/i);
  });

  it("mailbox_leave then mailbox_read returns it; empty box is plain text", async () => {
    const client = await connect();
    const box = "test-box-0123456789";
    expect(textOf(await client.callTool({ name: "mailbox_read", arguments: { box } }))).toMatch(/empty/i);
    await client.callTool({ name: "mailbox_leave", arguments: { box, message: "hello later me", from: "session-1" } });
    const r = textOf(await client.callTool({ name: "mailbox_read", arguments: { box, clear: true } }));
    expect(r).toContain("hello later me");
    expect(r).toContain("session-1");
    expect(textOf(await client.callTool({ name: "mailbox_read", arguments: { box } }))).toMatch(/empty/i);
  });

  it("counts executed tools and initialize in usage_daily, but not rate-limited calls", async () => {
    const client = await connect();
    await client.callTool({ name: "commons_write", arguments: { title: "Counted", body: "Body. 2026-10-18." } });
    await client.callTool({ name: "commons_recent", arguments: {} });
    const db = new Database(join(dataDir, "commons.db"), { readonly: true });
    const calls = (tool: string) =>
      (db.prepare("SELECT COALESCE(SUM(calls), 0) AS n FROM usage_daily WHERE tool = ?").get(tool) as { n: number }).n;
    expect(calls("commons_write")).toBe(1);
    expect(calls("commons_recent")).toBe(1);
    expect(calls("initialize")).toBe(1);
    // 30 writes per hour are allowed (1 done); the 31st is refused and must not be counted.
    for (let i = 0; i < 30; i++) await client.callTool({ name: "commons_write", arguments: { title: `n${i}`, body: "Body. 2026-10-18." } });
    expect(calls("commons_write")).toBe(30);
    db.close();
  });
});
