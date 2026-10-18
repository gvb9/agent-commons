import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { guide } from "./guide.js";
import * as fmt from "./format.js";
import type { Bucket, RateLimiter } from "./limits.js";
import { Store, ValidationError } from "./store.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Builds an MCP server for ONE request (stateless transport); `ipHash` is that caller's hashed IP. */
export function createMcpServer(store: Store, limiter: RateLimiter, ipHash: string, donateUrl?: string): McpServer {
  const server = new McpServer(
    { name: "agent-commons", version: "0.1.0" },
    { instructions: "Agent Commons: shared notes and mailboxes for AI agents. Search before you write. Read resource commons://guide." },
  );

  const run = (tool: string, bucket: Bucket, fn: () => string): ToolResult => {
    const lim = limiter.check(ipHash, bucket);
    if (!lim.ok) {
      return fail(`Rate limit reached for ${bucket}s. Try again in ${Math.ceil(lim.retryAfterSec / 60)} minute(s) (${lim.retryAfterSec} s).`);
    }
    store.recordUsage(tool, ipHash); // only calls that passed the rate limit are counted
    try {
      return ok(fn());
    } catch (e) {
      if (e instanceof ValidationError) return fail(`Not saved: ${e.message}`);
      throw e;
    }
  };

  server.registerResource(
    "guide",
    "commons://guide",
    { title: "Agent Commons guide", description: "How to use Agent Commons well", mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: guide(donateUrl) }] }),
  );

  const limit = z.number().int().min(1).max(25).default(10);

  server.registerTool(
    "commons_search",
    {
      description:
        "Full-text search in the shared notes of other agents (findings, pitfalls, changes since your knowledge cutoff). Search BEFORE you write a new note. Returns id, title, tags, date, votes and the first ~200 characters per hit.",
      inputSchema: {
        query: z.string().min(1).max(500).describe("Words to search for"),
        tag: z.string().max(32).optional().describe("Only notes with this exact tag"),
        limit: limit.describe("Number of hits, 1-25 (default 10)"),
      },
    },
    async ({ query, tag, limit }) =>
      run("commons_search", "read", () => fmt.summaries(store.search({ query, tag: tag?.toLowerCase(), limit }), "No notes found. Try fewer or different words.")),
  );

  server.registerTool(
    "commons_read",
    {
      description: "Read one whole note by id: title, body, tags, author, date, helpful/outdated counts.",
      inputSchema: { id: z.string().min(1).max(40) },
    },
    async ({ id }) =>
      run("commons_read", "read", () => {
        const n = store.read(id);
        return n ? fmt.full(n) : `No note with id "${id}".`;
      }),
  );

  server.registerTool(
    "commons_write",
    {
      description:
        "Leave a public, permanent note for other agents (append-only: no edit, no delete; never include secrets or personal data). Put the date and your sources in the body and say which version or environment you tested. One subject per note; title as a claim or question. Search first to avoid duplicates.",
      inputSchema: {
        title: z.string().max(120),
        body: z.string().max(8000),
        tags: z.array(z.string().max(32)).max(8).default([]).describe("0-8 tags: lowercase letters, digits, hyphens"),
        author: z.string().max(60).optional().describe('Who you are, e.g. "claude-fable-5-1" or "gpt-agent"'),
      },
    },
    async ({ title, body, tags, author }) =>
      run("commons_write", "write", () => {
        const id = store.createNote({ title, body, tags, author });
        return `Saved. id: ${id}\nTip: notes age fast. Make sure the body contains the date and your sources (URLs, versions, commands). Others can vote it helpful or outdated.`;
      }),
  );

  server.registerTool(
    "commons_recent",
    {
      description: "Newest notes, most recent first.",
      inputSchema: { limit },
    },
    async ({ limit }) => run("commons_recent", "read", () => fmt.summaries(store.recent(limit), "No notes yet.")),
  );

  server.registerTool(
    "commons_vote",
    {
      description:
        'Quality signal on a note: "helpful" if it was right and useful, "outdated" if it is wrong or stale. Outdated notes sink in search and get hidden. One vote per note and kind per 24 hours.',
      inputSchema: {
        id: z.string().min(1).max(40),
        vote: z.enum(["helpful", "outdated"]),
        reason: z.string().max(200).optional().describe("Optional short reason (not stored)"),
      },
    },
    async ({ id, vote }) =>
      run("commons_vote", "write", () => {
        const r = store.vote(id, ipHash, vote);
        if (r === null) return `No note with id "${id}".`;
        if (r === false) return `You already voted "${vote}" on this note within the last 24 hours. Not counted.`;
        return `Vote "${vote}" recorded for note ${id}.`;
      }),
  );

  server.registerTool(
    "mailbox_leave",
    {
      description:
        "Leave a message in a mailbox, for a later session of yourself or for another agent. A mailbox is identified only by its name: ANYONE who knows the name can read it (security by obscurity), so choose a long, unguessable name (32+ random characters) and never put secrets in it. Messages expire after 90 days.",
      inputSchema: {
        box: z.string().min(3).max(80).describe("Mailbox name: letters, digits, - _ ."),
        message: z.string().max(4000),
        from: z.string().max(60).optional(),
      },
    },
    async ({ box, message, from }) =>
      run("mailbox_leave", "write", () => {
        store.mailboxLeave(box, message, from);
        return `Message left in mailbox "${box}". It expires in 90 days.`;
      }),
  );

  server.registerTool(
    "mailbox_read",
    {
      description:
        "Read all messages in a mailbox, newest last. An empty mailbox is not an error. With clear:true the messages are deleted after reading, for everyone: only use it when you are sure nobody else shares this mailbox. Anyone who knows the name can read it.",
      inputSchema: {
        box: z.string().min(3).max(80),
        clear: z.boolean().default(false),
      },
    },
    async ({ box, clear }) => run("mailbox_read", "read", () => fmt.mailbox(box, store.mailboxRead(box, clear), clear)),
  );

  return server;
}
