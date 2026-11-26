import path from "node:path";
import crypto from "node:crypto";
import { emptyUsage, contextTokens, callSignature, CONFIDENCE } from "../schema.mjs";

/**
 * Codex CLI adapter (A7). Reads `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (plain JSONL; the compressed `archived_sessions` are not read,
 * to keep Sparelimit free of dependencies).
 *
 * What the log gives, checked on 150 real sessions (Codex CLI 0.165):
 *  - `token_usage_record`: one per API response, with `response_id` and `usage` {input_tokens (INCLUDES the cached part), cached_input_tokens,
 *    cache_write_input_tokens, output_tokens (INCLUDES reasoning), reasoning_output_tokens}. Preferred. In 91 of 118 files that have both, its
 *    totals equal the `token_count` events' exactly; in the other 27 the records are slightly larger, so `token_count` loses a few responses.
 *  - `event_msg:token_count` with `info.last_token_usage` / `total_token_usage`: the fallback, de-duplicated on identical running totals. The
 *    per-call figures add up to the final total exactly.
 *  - `cache_write_input_tokens` was zero in all 8,102 events seen. If it is ever present it is treated as part of the input (an assumption).
 *  - `turn_context.model` names the model; a call is priced by the last model seen before it. Calls come BEFORE the usage record of their
 *    response, and their outputs after it, so calls attach to the next record.
 * A subagent is a file of its own (`session_meta.source.subagent`) that names its parent in `parent_thread_id`: on 155 real sessions every one
 * of 134 subagents had its parent present, up to two levels deep. The adapter keeps both ids; grouping is done in the report.
 * Limits: Files touched are not extracted. Cost is exact in tokens, priced at list price like
 * every other figure, and estimated when the model is not in the price list.
 */
/** @param {any[]} objs */
export function looksLikeCodex(objs) {
  return objs.some((/** @type {any} */ o) => o.type === "session_meta" && o.payload && typeof o.payload === "object" && ("cli_version" in o.payload || "originator" in o.payload));
}

const num = (/** @type {any} */ x) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);

/** @param {any} u */
export function codexUsage(u) {
  const input = num(u?.input_tokens);
  const cached = Math.min(num(u?.cached_input_tokens), input);
  const write = Math.min(num(u?.cache_write_input_tokens), input - cached);
  return { ...emptyUsage(), input: input - cached - write, cacheRead: cached, cacheWrite5m: write, output: num(u?.output_tokens) };
}

const textOf = (/** @type {any} */ c) => (Array.isArray(c) ? c.filter((/** @type {any} */ b) => typeof b?.text === "string" && /text/.test(b.type || "")).map((/** @type {any} */ b) => b.text).join("\n") : typeof c === "string" ? c : "");
// the CLI injects context as messages of its own, wrapped in a tag; what the person typed does not start with one
const INJECTED = /^\s*</;
const outText = (/** @type {any} */ o) => (typeof o === "string" ? o : o == null ? "" : JSON.stringify(o));
const FAILED = /^\s*(error\b|failed\b|exit code:?\s*[1-9]|command failed)/i;

/** @param {string} filePath @param {any[]} objs */
export function parseCodex(filePath, objs) {
  const meta = objs.find((o) => o.type === "session_meta")?.payload || {};
  const sessionId = meta.id || meta.session_id || path.basename(filePath, ".jsonl");
  const records = objs.filter((o) => o.type === "token_usage_record" && o.payload?.usage);
  const useRecords = records.length > 0;

  /** @type {string | null} */
  let model = null;
  /** @type {any[]} */
  let pending = []; // calls seen since the last usage record
  const callById = new Map();
  /** @type {any[]} */
  const events = [];
  const seenResp = new Set();
  const seenTotals = new Set();
  const userTurns = [];
  const commandResults = [];
  let usageLines = 0;
  let rateLimits = null;
  let rateLimitsAt = null;
  const rateSamples = []; // the plan-limit readings over time (account-wide), kept to forecast from

  const push = (/** @type {string} */ id, /** @type {string} */ ts, /** @type {any} */ usageRaw) => {
    const usage = codexUsage(usageRaw);
    const ctx = contextTokens(usage);
    if (!ctx && !usage.output) return; // a record with no usable figures
    events.push({ id, ts, model, isSidechain: false, usage, context: ctx, tools: pending.map((c) => c.name), calls: pending, confidence: CONFIDENCE.DERIVED });
    pending = [];
  };

  for (const o of objs) {
    const p = o.payload || {};
    if (o.type === "turn_context" && typeof p.model === "string") model = p.model;
    if (o.type === "token_usage_record" && useRecords) {
      usageLines += 1;
      const id = p.response_id || `${o.ordinal}`;
      if (seenResp.has(id)) continue;
      seenResp.add(id);
      push(id, o.timestamp, p.usage);
      continue;
    }
    if (o.type === "event_msg" && p.type === "token_count" && p.info) {
      if (p.rate_limits) {
        rateLimits = p.rate_limits;
        rateLimitsAt = o.timestamp;
        const rl = p.rate_limits;
        const five = rl.primary?.window_minutes === 300 ? rl.primary : null;
        const week = rl.secondary?.window_minutes === 10080 ? rl.secondary : null;
        const t = Date.parse(o.timestamp);
        const last = rateSamples[rateSamples.length - 1];
        const fh = five?.used_percent ?? null;
        const sd = week?.used_percent ?? null;
        if (Number.isFinite(t) && (fh != null || sd != null) && !(last && last.fh === fh && last.sd === sd && last.fhReset === five?.resets_at)) {
          rateSamples.push({ t, fh, sd, fhReset: five?.resets_at ?? null, sdReset: week?.resets_at ?? null });
        }
      }
      if (useRecords) continue;
      usageLines += 1;
      const key = JSON.stringify(p.info.total_token_usage);
      if (seenTotals.has(key)) continue;
      seenTotals.add(key);
      push(`tc-${o.ordinal ?? events.length}`, o.timestamp, p.info.last_token_usage);
      continue;
    }
    if (o.type !== "response_item") continue;
    if (p.type === "function_call" || p.type === "custom_tool_call") {
      let args = p.arguments ?? p.input ?? "";
      try {
        if (typeof args === "string") args = JSON.parse(args);
      } catch {}
      const call = { id: p.call_id, name: p.name || p.type, sig: callSignature(p.name || p.type, args) };
      pending.push(call);
      callById.set(p.call_id, { call, args });
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const hit = callById.get(p.call_id);
      if (!hit) continue;
      const text = outText(p.output);
      hit.call.resChars = text.length;
      hit.call.res = `${FAILED.test(text) ? "!" : ""}${crypto.createHash("sha1").update(text.slice(0, 400)).digest("hex").slice(0, 10)}`;
      if (hit.call.name === "exec" || hit.call.name === "shell" || hit.call.name === "local_shell") {
        const cmd = typeof hit.args === "string" ? hit.args : hit.args?.cmd || hit.args?.command || "";
        const ok = !FAILED.test(text);
        commandResults.push({ command: String(Array.isArray(cmd) ? cmd.join(" ") : cmd).slice(0, 300), ok, summary: ok ? "" : text.split("\n").find((l) => l.trim())?.trim().slice(0, 160) || "failed" });
      }
    } else if (p.type === "message" && p.role === "user") {
      const text = textOf(p.content);
      if (text.trim() && !INJECTED.test(text)) userTurns.push({ text: text.trim().slice(0, 320), createdAt: o.timestamp });
    }
  }

  return {
    agent: "codex",
    sessionId,
    transcriptPath: filePath,
    threadId: meta.id || null,
    parentId: typeof meta.parent_thread_id === "string" ? meta.parent_thread_id : null,
    projectDir: typeof meta.cwd === "string" ? meta.cwd : null,
    subagent: !!meta.source?.subagent,
    events,
    userTurns,
    commandResults,
    fileTouches: [],
    raw: { lines: objs.length, usageLines, uniqueResponses: events.length, source: useRecords ? "token_usage_record" : "token_count", rateLimits, rateLimitsAt, rateSamples: rateSamples.slice(-2000) }
  };
}
