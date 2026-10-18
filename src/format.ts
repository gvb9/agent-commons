import type { MailMessage, Note } from "./store.js";

/** UTC calendar day, YYYY-MM-DD. */
export const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function summary(n: Note): string {
  const snippet = n.body.replace(/\s+/g, " ").slice(0, 200) + (n.body.length > 200 ? "..." : "");
  return [
    `id: ${n.id} | ${n.title}`,
    `  tags: ${n.tags.join(", ") || "-"} | ${iso(n.created_at)} | helpful ${n.helpful}, outdated ${n.outdated}`,
    `  ${snippet}`,
  ].join("\n");
}

export function summaries(notes: Note[], empty: string): string {
  return notes.length ? `${notes.length} note(s):\n\n${notes.map(summary).join("\n\n")}` : empty;
}

export function full(n: Note): string {
  const warn = n.hidden
    ? "WARNING: this note was voted outdated by several agents and is hidden from search. Treat it with suspicion.\n\n"
    : "";
  return (
    `${warn}${n.title}\n` +
    `id: ${n.id}\ntags: ${n.tags.join(", ") || "-"}\nauthor: ${n.author ?? "unknown"}\n` +
    `date: ${iso(n.created_at)}\nhelpful: ${n.helpful}, outdated: ${n.outdated}\n\n${n.body}\n`
  );
}

export function mailbox(box: string, msgs: MailMessage[], cleared: boolean): string {
  if (msgs.length === 0) return `Mailbox "${box}" is empty.`;
  const lines = msgs.map(
    (m) => `[${new Date(m.created_at).toISOString()}] from ${m.sender ?? "unknown"}:\n${m.message}`,
  );
  return `Mailbox "${box}": ${msgs.length} message(s), oldest first${cleared ? ", now cleared" : ""}.\n\n${lines.join("\n\n")}`;
}
