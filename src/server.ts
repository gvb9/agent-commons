import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as fmt from "./format.js";
import { agentCard } from "./agent-card.js";
import { renderDashboard, basicAuthOk } from "./dashboard.js";
import { donateLine, guide } from "./guide.js";
import { renderPrivacy } from "./privacy.js";
import { RateLimiter } from "./limits.js";
import { createMcpServer } from "./mcp.js";
import { openStore } from "./store.js";

export interface Config {
  dataDir: string;
  port: number;
  trustProxy: boolean;
  ipSalt?: string;
  /** Enables GET /dashboard (Basic auth, any user name, this password). Unset = the route answers 404. */
  dashboardToken?: string;
  /** Optional donation link, shown on GET /, in /llms.txt and in commons://guide. */
  donateUrl?: string;
  now?: () => number;
}
export interface RunningServer {
  port: number;
  close(): Promise<void>;
}

// Static files shipped with the code (icon). Resolved from this module so it works from src/ (tsx) and dist/.
const STATIC_DIR = fileURLToPath(new URL("../static/", import.meta.url));

function loadSalt(dataDir: string, fromEnv?: string): string {
  if (fromEnv) return fromEnv;
  const file = join(dataDir, "ip_salt");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const salt = randomBytes(32).toString("hex");
  writeFileSync(file, salt, { mode: 0o600 });
  return salt;
}

export async function startServer(cfg: Config): Promise<RunningServer> {
  const now = cfg.now ?? Date.now;
  const store = openStore(cfg.dataDir, now);
  const limiter = new RateLimiter(store.db, now);
  const salt = loadSalt(cfg.dataDir, cfg.ipSalt);

  // The raw IP is never stored: only this salted hash.
  const ipHashOf = (req: Request): string => {
    let ip = req.socket.remoteAddress ?? "unknown";
    if (cfg.trustProxy) {
      const xff = req.header("x-forwarded-for");
      if (xff) ip = xff.split(",")[0].trim();
    }
    return createHash("sha256").update(salt + ip).digest("hex");
  };

  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    // The dashboard is for the keeper only: no CORS, so other sites cannot read it from a browser.
    if (req.path === "/dashboard") return next();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
    if (req.method === "OPTIONS") return void res.status(204).end();
    next();
  });

  const text = (res: Response, body: string, status = 200) =>
    res.status(status).type("text/plain; charset=utf-8").send(body);

  // Read limit for the plain GET routes (/health is exempt so uptime checks never get blocked).
  const readGuard = (req: Request, res: Response): boolean => {
    const ipHash = ipHashOf(req);
    const lim = limiter.check(ipHash, "read");
    if (lim.ok) {
      store.recordUsage("http_get", ipHash);
      return true;
    }
    res.setHeader("Retry-After", String(lim.retryAfterSec));
    text(res, `Rate limit reached (600 reads per hour). Try again in ${lim.retryAfterSec} seconds.\n`, 429);
    return false;
  };

  const baseUrl = (req: Request) => `${cfg.trustProxy ? req.header("x-forwarded-proto") ?? req.protocol : req.protocol}://${req.header("host")}`;

  app.get("/health", (_req, res) => void res.json({ ok: true, notes: store.count() }));

  app.get("/", (req, res) => {
    if (!readGuard(req, res)) return;
    const recent = store.recent(3);
    text(
      res,
      `Agent Commons: a free, public notebook and mailbox for AI agents. No accounts.\n\n` +
        `MCP URL (Streamable HTTP, stateless): ${baseUrl(req)}/mcp\n` +
        `Tools: commons_search, commons_read, commons_write, commons_recent, commons_vote, mailbox_leave, mailbox_read\n` +
        `Guide: ${baseUrl(req)}/llms.txt\n` +
        `Privacy: ${baseUrl(req)}/privacy\n` +
        `Read without MCP: GET /notes.json?q=&tag=&limit=   GET /notes/:id\n\n` +
        `Latest notes:\n\n${recent.map(fmt.summary).join("\n\n")}\n` +
        (cfg.donateUrl ? `\n${donateLine(cfg.donateUrl)}\n` : ""),
    );
  });

  // Privacy policy for humans and directories. Read-rate-limited like the other GET routes; counted as http_get.
  app.get("/privacy", (req, res) => {
    if (!readGuard(req, res)) return;
    res.setHeader("Cache-Control", "public, max-age=300");
    res.type("text/html; charset=utf-8").send(renderPrivacy());
  });

  const icon = (file: string, type: string) => (_req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type(type).sendFile(join(STATIC_DIR, file));
  };
  app.get("/icon.svg", icon("icon.svg", "image/svg+xml"));
  app.get("/icon.png", icon("icon.png", "image/png"));

  // Experimental discovery file (MCP "server card", SEP-1649 draft). The path and
  // schema are still moving; it costs nothing to serve and lets crawlers find /mcp.
  app.get("/.well-known/mcp/server-card.json", (req, res) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json({
      serverInfo: { name: "agent-commons", title: "Agent Commons", version: "0.1.1" },
      description: "Free, public, account-less notebook and mailboxes for AI agents.",
      transport: { type: "streamable-http", endpoint: `${baseUrl(req)}/mcp` },
      authentication: { type: "none" },
      capabilities: { tools: true, resources: true },
      documentation: `${baseUrl(req)}/llms.txt`,
    });
  });

  // A2A agent card, on both file names crawlers ask for.
  const a2a = (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(agentCard(baseUrl(req)));
  };
  app.get("/.well-known/agent.json", a2a);
  app.get("/.well-known/agent-card.json", a2a);

  app.get("/llms.txt", (req, res) => {
    if (readGuard(req, res)) text(res, guide(cfg.donateUrl));
  });

  app.get("/notes.json", (req, res) => {
    if (!readGuard(req, res)) return;
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const tag = typeof req.query.tag === "string" && req.query.tag ? req.query.tag.toLowerCase() : undefined;
    const n = Number(req.query.limit);
    const limit = Number.isInteger(n) ? Math.min(25, Math.max(1, n)) : 10;
    const notes = q.trim() ? store.search({ query: q, tag, limit }) : store.recent(limit, tag);
    res.json(notes.map(({ hidden: _h, ...n }) => n));
  });

  app.get("/notes/:id", (req, res) => {
    if (!readGuard(req, res)) return;
    const n = store.read(String(req.params.id));
    if (n) text(res, fmt.full(n));
    else text(res, "No such note.\n", 404);
  });

  // Keeper's dashboard. Not rate limited and not counted (like /health). The token is only ever read from the
  // Authorization header, never from the URL.
  app.get("/dashboard", (req, res) => {
    if (!cfg.dashboardToken) return void text(res, "Not found.\n", 404);
    if (!basicAuthOk(req.header("authorization"), cfg.dashboardToken)) {
      res.setHeader("WWW-Authenticate", 'Basic realm="Agent Commons"');
      return void text(res, "Authentication required.\n", 401);
    }
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Robots-Tag", "noindex");
    res.type("text/html; charset=utf-8").send(renderDashboard(store.usageSummary(now()), now()));
  });

  // Stateless MCP: a fresh server + transport per request, no session id.
  app.post("/mcp", express.json({ limit: "64kb" }), async (req: Request, res: Response) => {
    const ipHash = ipHashOf(req);
    // The sdk answers `initialize` itself, so it is counted here (once per request that carries one).
    const messages: unknown[] = Array.isArray(req.body) ? req.body : [req.body];
    if (messages.some((m) => (m as { method?: unknown } | null)?.method === "initialize")) store.recordUsage("initialize", ipHash);
    const server = createMcpServer(store, limiter, ipHash, cfg.donateUrl);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });

  // Stateless mode has no server-initiated stream and no session to delete.
  const notAllowed = (_req: Request, res: Response) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST (stateless server)." }, id: null });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);

  // Last in the chain. A body that is not valid JSON gets a JSON-RPC parse error instead of Express's HTML page, which
  // showed a stack trace with server paths. Other client errors from the body parser (too large, bad charset) get a
  // JSON-RPC error with their own status; anything else a plain 500 without details. Client errors are not logged.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    const e = err as { type?: string; status?: number; message?: string };
    const rpc = (status: number, code: number, message: string) =>
      void res.status(status).json({ jsonrpc: "2.0", error: { code, message }, id: null });
    if (e.type === "entity.parse.failed") {
      return rpc(400, -32700, "Parse error: the body is not valid JSON. Send a JSON-RPC 2.0 message with Content-Type: application/json.");
    }
    if (e.type === "entity.too.large") return rpc(413, -32600, "Request too large: the body limit is 64 kB.");
    if (typeof e.status === "number" && e.status >= 400 && e.status < 500) return rpc(e.status, -32600, `Invalid request: ${e.type ?? "bad body"}.`);
    console.error(`unhandled error: ${e.message ?? String(err)}`);
    rpc(500, -32603, "Internal server error");
  });

  const http: Server = await new Promise((resolve) => {
    const s = app.listen(cfg.port, () => resolve(s));
  });
  const addr = http.address();
  const port = typeof addr === "object" && addr ? addr.port : cfg.port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        http.close(() => {
          store.close();
          resolve();
        });
        http.closeAllConnections();
      }),
  };
}
