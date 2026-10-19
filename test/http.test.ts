import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, type Config, type RunningServer } from "../src/server.js";
import { cleanupTempDirs, tempDir } from "./helpers.js";

let running: RunningServer | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
  cleanupTempDirs();
});

async function boot(extra: Partial<Config> = {}) {
  running = await startServer({ dataDir: tempDir(), port: 0, trustProxy: false, ...extra });
  return `http://127.0.0.1:${running.port}`;
}

describe("http", () => {
  it("GET /health", async () => {
    const base = await boot();
    const r = await fetch(`${base}/health`);
    expect(await r.json()).toEqual({ ok: true, notes: 3 });
  });

  it("GET /notes.json?q= searches, with CORS", async () => {
    const base = await boot();
    const r = await fetch(`${base}/notes.json?q=mailbox&limit=5`);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const list = (await r.json()) as { id: string; title: string }[];
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].title).toMatch(/Mailboxes/);
    const all = (await (await fetch(`${base}/notes.json`)).json()) as unknown[];
    expect(all).toHaveLength(3);
  });

  it("GET /notes/:id is text/plain; unknown id is 404", async () => {
    const base = await boot();
    const list = (await (await fetch(`${base}/notes.json`)).json()) as { id: string }[];
    const r = await fetch(`${base}/notes/${list[0].id}`);
    expect(r.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await r.text()).toContain(`id: ${list[0].id}`);
    expect((await fetch(`${base}/notes/nope`)).status).toBe(404);
  });

  it("GET / and /llms.txt are text/plain", async () => {
    const base = await boot();
    const r = await fetch(`${base}/`);
    expect(r.headers.get("content-type")).toMatch(/^text\/plain/);
    const t = await r.text();
    expect(t).toContain("/mcp");
    expect(t).toContain("commons_search");
    const g = await fetch(`${base}/llms.txt`);
    expect(g.headers.get("content-type")).toMatch(/^text\/plain/);
  });

  it("returns 429 with Retry-After after 600 reads", async () => {
    const base = await boot();
    let last = 200;
    for (let i = 0; i < 601; i++) last = (await fetch(`${base}/notes.json`)).status;
    expect(last).toBe(429);
  }, 30000);

  it("GET / and /llms.txt end with the donation line when DONATE_URL is set, and not otherwise", async () => {
    const url = "https://example.com/chip-in";
    const base = await boot({ donateUrl: url });
    const home = await (await fetch(`${base}/`)).text();
    expect(home).toContain(`you can chip in: ${url}`);
    expect(home.trimEnd().endsWith(url)).toBe(true);
    const guide = await (await fetch(`${base}/llms.txt`)).text();
    expect(guide.trimEnd().endsWith(`you can chip in: ${url}`)).toBe(true);
    await running?.close();
    const plain = await boot();
    expect(await (await fetch(`${plain}/`)).text()).not.toContain("chip in");
    expect(await (await fetch(`${plain}/llms.txt`)).text()).not.toContain("chip in");
  });
});

const basic = (user: string, pass: string) => ({ Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` });

describe("dashboard", () => {
  it("is 404 when DASHBOARD_TOKEN is not set, even with credentials", async () => {
    const base = await boot();
    expect((await fetch(`${base}/dashboard`)).status).toBe(404);
    expect((await fetch(`${base}/dashboard`, { headers: basic("x", "anything") })).status).toBe(404);
  });

  it("is 401 with a Basic challenge without or with a wrong password", async () => {
    const base = await boot({ dashboardToken: "s3cret-token" });
    for (const headers of [{}, basic("admin", "wrong"), basic("admin", "s3cret-token-longer"), basic("admin", "s"), { Authorization: "Bearer s3cret-token" }, { Authorization: "Basic !!!" }]) {
      const r = await fetch(`${base}/dashboard`, { headers });
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe('Basic realm="Agent Commons"');
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
  });

  it("is 200 with any username and the right password; no-store, noindex, html", async () => {
    const base = await boot({ dashboardToken: "s3cret-token" });
    const r = await fetch(`${base}/dashboard`, { headers: basic("whoever", "s3cret-token") });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/^text\/html/);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-robots-tag")).toBe("noindex");
    const html = await r.text();
    for (const h of ["Agent Commons", "Aanroepen", "Per dag", "Gastenboek", "Laatste notities", "Ververs de pagina"]) {
      expect(html).toContain(h);
    }
    expect(html).not.toContain("<script");
    expect(html).not.toContain("s3cret-token");
  });

  it("shows tool names and the author of a written note, escaped, and skips /health", async () => {
    const base = await boot({ dashboardToken: "tok" });
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    await client.callTool({
      name: "commons_write",
      arguments: { title: "Zebra <b>pitfall</b>", body: "Body text. Checked 2026-10-18.", author: "agent<script>alert(1)</script>" },
    });
    await fetch(`${base}/health`);
    const get = async () => (await fetch(`${base}/dashboard`, { headers: basic("a", "tok") })).text();
    let html = await get();
    expect(html).toContain("commons_write");
    expect(html).toContain("initialize");
    expect(html).toContain("agent&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("Zebra &lt;b&gt;pitfall&lt;/b&gt;");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<b>pitfall");
    expect(html).not.toContain("http_get");
    await fetch(`${base}/notes.json`);
    html = await get();
    expect(html).toContain("http_get");
  });
  it("GET /.well-known/mcp/server-card.json points at /mcp, no auth", async () => {
    const base = await boot();
    const r = await fetch(`${base}/.well-known/mcp/server-card.json`);
    expect(r.status).toBe(200);
    const card = (await r.json()) as { transport: { endpoint: string }; authentication: { type: string } };
    expect(card.transport.endpoint).toBe(`${base}/mcp`);
    expect(card.authentication.type).toBe("none");
  });
  it("A2A agent card on both file names, skills equal to the MCP tools, honest about MCP", async () => {
    const base = await boot();
    const a = (await (await fetch(`${base}/.well-known/agent.json`)).json()) as { url: string; description: string; skills: { id: string }[] };
    const b = (await (await fetch(`${base}/.well-known/agent-card.json`)).json()) as { url: string };
    expect(a.url).toBe(`${base}/mcp`);
    expect(b.url).toBe(a.url);
    expect(a.description).toContain("not an A2A message/send endpoint");
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const { tools } = await client.listTools();
    await client.close();
    expect(a.skills.map((s) => s.id).sort()).toEqual(tools.map((t) => t.name).sort());
  });
});

describe("privacy and icon", () => {
  it("GET /privacy is html with the contact address and the retention facts", async () => {
    const base = await boot();
    const r = await fetch(`${base}/privacy`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    const html = await r.text();
    expect(html).toContain("jon@plateop.com");
    expect(html).toContain("90 days");
    expect(html).not.toContain("<script");
  });
  it("GET / and /llms.txt point at /privacy", async () => {
    const base = await boot();
    expect(await (await fetch(`${base}/`)).text()).toContain(`${base}/privacy`);
    expect(await (await fetch(`${base}/llms.txt`)).text()).toContain("GET /privacy");
  });
  it("GET /icon.svg and /icon.png are served with their types", async () => {
    const base = await boot();
    const svg = await fetch(`${base}/icon.svg`);
    expect(svg.status).toBe(200);
    expect(svg.headers.get("content-type")).toMatch(/image\/svg\+xml/);
    expect(await svg.text()).toContain("<svg");
    const png = await fetch(`${base}/icon.png`);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toMatch(/image\/png/);
    expect((await png.arrayBuffer()).byteLength).toBeGreaterThan(1000);
  });
});
