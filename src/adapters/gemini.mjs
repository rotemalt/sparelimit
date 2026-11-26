import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { emptyUsage, contextTokens, callSignature, CONFIDENCE } from "../schema.mjs";

/**
 * Gemini CLI adapter (A8): `~/.gemini/tmp/<project>/chats/session-*.json` (one JSON document) and `session-*.jsonl` (a header line, then
 * message lines and `{"$set": ...}` patches that rewrite the messages: the same message id appears many times and the last version wins).
 * Seen on one machine with Gemini CLI sessions from 2025-10 to 2026-07; the layout is the CLI's own and not documented, so anything
 * unexpected is skipped.
 *
 * Tokens: each model message carries `tokens: { input, output, cached, thoughts, tool, total }`, and on every message seen
 * total = input + output + thoughts + tool, and `input` includes `cached`. So here: uncached input = input - cached (+ tool, the tool-use
 * prompt), cache read = cached, output = output + thoughts (thinking is billed as output). Those two assignments are the assumption; the counts
 * themselves are the CLI's own, so the confidence is "derived", not "exact". There is no cache-write price in these logs.
 * The project folder is read from the session-context message ("Workspace Directories"); the log keeps only a hash of it otherwise.
 */
export function looksLikeGemini(/** @type {any[]} */ objs) {
  return objs.some((o) => o && typeof o === "object" && typeof o.projectHash === "string" && typeof o.sessionId === "string" && (Array.isArray(o.messages) || "kind" in o || "startTime" in o));
}

const num = (/** @type {any} */ x) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
const textOf = (/** @type {any} */ c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((/** @type {any} */ b) => (typeof b?.text === "string" ? b.text : "")).join("\n") : "");
/**
 * The project folder of a session from where it is kept: `~/.gemini/tmp/<name>/chats/<file>`, where <name> is either the short name that
 * `~/.gemini/projects.json` gives a folder, or the SHA-256 of the folder path. Null when neither matches.
 * @param {string} filePath
 */
function projectDirOf(filePath) {
  try {
    const name = path.basename(path.dirname(path.dirname(filePath)));
    const projects = JSON.parse(fs.readFileSync(path.join(path.dirname(filePath), "..", "..", "..", "projects.json"), "utf8"))?.projects || {};
    for (const [dir, short] of Object.entries(projects)) if (short === name || crypto.createHash("sha256").update(dir).digest("hex") === name) return dir;
  } catch {}
  return null;
}

const FILE_TOOLS = /^(read_file|read_many_files|write_file|replace|edit|read_file_range)$/;
const WRITE_TOOLS = /^(write_file|replace|edit)$/;

/** The messages of a session in order, each at its latest version. @returns {any[]} */
function collectMessages(/** @type {any[]} */ objs) {
  /** @type {Map<string, any>} */
  const byId = new Map();
  const put = (/** @type {any} */ m) => {
    if (m && typeof m === "object" && typeof m.id === "string") byId.set(m.id, m);
  };
  for (const o of objs) {
    if (Array.isArray(o?.messages)) o.messages.forEach(put);
    else if (o?.$set && Array.isArray(o.$set.messages)) o.$set.messages.forEach(put);
    else if (o?.id && o?.type) put(o);
  }
  return [...byId.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export function parseGemini(/** @type {string} */ filePath, /** @type {any[]} */ objs) {
  const header = objs.find((o) => typeof o?.projectHash === "string") || {};
  const messages = collectMessages(objs);
  const sessionId = path.basename(filePath).replace(/\.jsonl?$/, ""); // the header id is shared by many background sessions, the file name is not
  /** @type {any[]} */
  const events = [];
  /** @type {{ text: string, createdAt?: string }[]} */
  const userTurns = [];
  /** @type {{ command: string, ok: boolean, summary: string }[]} */
  const commandResults = [];
  /** @type {any[]} */
  const fileTouches = [];
  /** @type {string | null} */
  let projectDir = null;
  let usageLines = 0;

  for (const m of messages) {
    if (m.type === "user") {
      const t = textOf(m.content);
      const ctx = t.match(/Workspace Directories:\*\*\s*\n\s*-\s*([^\n]+)/);
      if (ctx && !projectDir) projectDir = ctx[1].trim();
      if (t.trim() && !/^\s*<session_context>/.test(t) && !/^\[Function Response/.test(t)) userTurns.push({ text: t.trim().slice(0, 320), createdAt: m.timestamp });
      continue;
    }
    if (m.type !== "gemini" || !m.tokens || typeof m.tokens !== "object") continue;
    usageLines += 1;
    const tk = m.tokens;
    const cached = Math.min(num(tk.cached), num(tk.input));
    const usage = { ...emptyUsage(), input: num(tk.input) - cached + num(tk.tool), cacheRead: cached, output: num(tk.output) + num(tk.thoughts) };
    const ctxTokens = contextTokens(usage);
    if (!ctxTokens && !usage.output) continue;
    const calls = [];
    for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
      const outText = JSON.stringify(c.result ?? "");
      const failed = c.status && c.status !== "success";
      const file = typeof c.args?.file_path === "string" ? c.args.file_path : typeof c.args?.absolute_path === "string" ? c.args.absolute_path : undefined;
      calls.push({ id: c.id, name: String(c.name || "tool"), sig: callSignature(String(c.name || "tool"), c.args ?? {}), res: `${failed ? "!" : ""}${crypto.createHash("sha1").update(outText.slice(0, 400)).digest("hex").slice(0, 10)}`, resChars: outText.length, ...(file ? { file } : {}) });
      if (file && FILE_TOOLS.test(c.name)) fileTouches.push({ file, kind: WRITE_TOOLS.test(c.name) ? "write" : "read", id: c.id });
      if (c.name === "run_shell_command") {
        const out = c.result?.[0]?.functionResponse?.response?.output;
        commandResults.push({ command: String(c.args?.command || "").slice(0, 300), ok: !failed, summary: failed ? String(typeof out === "string" ? out : "").split("\n").find((/** @type {string} */ l) => l.trim())?.trim().slice(0, 160) || "Failed" : "" });
      }
    }
    events.push({ id: m.id, ts: m.timestamp, model: typeof m.model === "string" ? m.model : null, isSidechain: false, usage, context: ctxTokens, tools: calls.map((c) => c.name), calls, confidence: CONFIDENCE.DERIVED });
  }
  return { agent: "gemini", sessionId, transcriptPath: filePath, events, userTurns, commandResults, fileTouches, projectDir: projectDir || projectDirOf(filePath), subagent: header.kind != null && header.kind !== "main", raw: { usageLines, uniqueResponses: events.length } };
}
