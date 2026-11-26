import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * What Cursor's local data says about token use (tokens only, no dollars).
 *
 * Cursor keeps its chat state in one SQLite file (`state.vscdb`, table `cursorDiskKV`). A message ("bubble") is a row whose key is
 * `bubbleId:<composerId>:<bubbleId>` and whose value is JSON with `tokenCount: { inputTokens, outputTokens }`. The layout is Cursor's own
 * and not documented. On the one machine checked, nearly every message had no model name, and Cursor bills by request and plan rather than by
 * token, so no dollar figure is attempted: a number would look exact and be a guess. The file is read through the system `sqlite3`
 * program (read-only, immutable) so the tool keeps having no dependencies; without it the command says so.
 */

/** Where Cursor keeps the file; `CURSOR_DB` overrides it. */
export function cursorDbPath({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (env.CURSOR_DB) return env.CURSOR_DB;
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Cursor", "User", "globalStorage", "state.vscdb");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Cursor", "User", "globalStorage", "state.vscdb");
}

const SQL = `select substr(key, 10, 36) as composerId,
  json_extract(value, '$.tokenCount.inputTokens') as input,
  json_extract(value, '$.tokenCount.outputTokens') as output,
  coalesce(json_extract(value, '$.timingInfo.clientRpcSendTime'), json_extract(value, '$.createdAt')) as ts,
  json_extract(value, '$.modelInfo.modelName') as model
from cursorDiskKV
where key like 'bubbleId:%' and (json_extract(value, '$.tokenCount.inputTokens') > 0 or json_extract(value, '$.tokenCount.outputTokens') > 0)`;

/**
 * The messages that carry token counts. Throws an Error with a plain-language message when the file or the `sqlite3` program is missing.
 * @param {string} dbPath
 * @param {(args: string[]) => string} [run] the sqlite3 call, replaceable in tests
 * @returns {{ composerId: string, input: number, output: number, ts: number | null, model: string | null }[]}
 */
export function readCursorMessages(dbPath, run = (args) => execFileSync("sqlite3", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })) {
  if (!fs.existsSync(dbPath)) throw new Error(`No Cursor data at ${dbPath} (set CURSOR_DB if yours is elsewhere).`);
  let out;
  try {
    out = run(["-json", `file:${dbPath}?mode=ro&immutable=1`, SQL]);
  } catch (/** @type {any} */ e) {
    if (e?.code === "ENOENT") throw new Error("The `sqlite3` program is needed to read Cursor's data and was not found.");
    throw new Error(`Could not read Cursor's data: ${String(e?.stderr || e?.message || e).split("\n")[0]}`);
  }
  const rows = out.trim() ? JSON.parse(out) : [];
  const n = (/** @type {any} */ x) => (typeof x === "number" && Number.isFinite(x) && x > 0 ? x : 0);
  const t = (/** @type {any} */ x) => (typeof x === "number" && x > 1e11 && x < 4e12 ? x : null); // milliseconds since 1970, else unknown
  return rows.map((/** @type {any} */ r) => ({ composerId: String(r.composerId), input: n(r.input), output: n(r.output), ts: t(r.ts), model: typeof r.model === "string" && r.model ? r.model : null }));
}

/**
 * @param {{ composerId: string, input: number, output: number, ts: number | null, model: string | null }[]} messages
 * @param {{ now?: number }} [opts]
 */
export function summarizeCursor(messages, { now = Date.now() } = {}) {
  /** @type {Map<string, { id: string, messages: number, input: number, output: number, start: number | null }>} */
  const sessions = new Map();
  /** @type {Map<string, number>} */
  const byDay = new Map();
  /** @type {Map<string, number>} */
  const byModel = new Map();
  let input = 0;
  let output = 0;
  let undated = 0;
  let unnamed = 0;
  for (const m of messages) {
    input += m.input;
    output += m.output;
    const s = sessions.get(m.composerId) || { id: m.composerId, messages: 0, input: 0, output: 0, start: null };
    s.messages += 1;
    s.input += m.input;
    s.output += m.output;
    if (m.ts != null && (s.start == null || m.ts < s.start)) s.start = m.ts;
    sessions.set(m.composerId, s);
    if (m.ts == null) undated += 1;
    else {
      const day = new Date(m.ts).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + m.input + m.output);
    }
    if (m.model) byModel.set(m.model, (byModel.get(m.model) || 0) + m.input + m.output);
    else unnamed += 1;
  }
  const since = new Date(now - 14 * 86400e3).toISOString().slice(0, 10);
  return {
    sessions: sessions.size,
    messages: messages.length,
    tokens: { input, output, total: input + output },
    messagesWithoutModel: unnamed,
    messagesWithoutDate: undated,
    byModel: [...byModel.entries()].map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens),
    last14Days: [...byDay.entries()].filter(([d]) => d >= since).sort((a, b) => a[0].localeCompare(b[0])).map(([day, tokens]) => ({ day, tokens })),
    top: [...sessions.values()].sort((a, b) => b.input + b.output - (a.input + a.output)).slice(0, 10).map((s) => ({ id: s.id, messages: s.messages, input: s.input, output: s.output, start: s.start == null ? null : new Date(s.start).toISOString() })),
    costUSD: null,
    confidence: "as Cursor logs them",
    note: "Token counts are what Cursor's local data records per message. No dollars are shown: Cursor bills by request and plan, and almost no message names its model, so a price would be a guess. Cache reads are not recorded separately. Cursor's own data layout is undocumented and may change."
  };
}
