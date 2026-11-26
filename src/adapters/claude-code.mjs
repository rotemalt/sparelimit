import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { emptyUsage, contextTokens, callSignature, CONFIDENCE } from "../schema.mjs";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** True when the parsed lines look like a Claude Code session log. */
export function looksLikeClaudeCode(/** @type {any[]} */ objs) {
  return objs.some((/** @type {any} */ o) => (o.type === "assistant" || o.type === "user") && o.message && typeof o.message === "object" && (o.sessionId || o.uuid));
}

/**
 * What started a stretch of work, from the text of the user-side record that began it (D: background-drain finder, K9). "typed" is you;
 * the rest is something that ran without you typing: a finished background task, a Stop hook asking the agent to continue (this includes
 * /goal), a continuation prompt after a cut-off or a compaction. A slash command you type counts as typed; command output, hook text and
 * reminders start nothing. Anything else the app injected is "other".
 * @param {string} text @param {boolean} isMeta
 * @returns {string | null} null when the record starts nothing
 */
export function triggerOf(text, isMeta) {
  const t = text.trim();
  if (isMeta && /^(\[Image|Base directory for this skill|<local-command-caveat)/.test(t)) return null; // a note about your own message: it starts nothing
  if (/^<task-notification/.test(t)) return "background-task";
  if (/^Stop hook feedback:/.test(t) || /^A session-scoped Stop hook/.test(t)) return "stop-hook";
  if (/^(Continue from where you left|Your response above was cut|This session is being continued)/.test(t)) return "continuation";
  // a slash command you typed starts work you asked for (a skill such as /code-review runs as a turn of its own); its output, a hook's text and a reminder start nothing
  if (/^<(command-name|command-message)/.test(t)) return "typed";
  if (NOT_TYPED.test(t)) return null;
  return isMeta ? "other" : "typed";
}

const max = (/** @type {any} */ a, /** @type {any} */ b) => Math.max(a || 0, b || 0);

function userText(/** @type {any} */ content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
}

// Slash-command echoes and injected reminders are not things the user typed.
const NOT_TYPED = /^\s*<(command-name|command-message|local-command|system-reminder|task-notification|user-prompt-submit-hook)/;

/**
 * Parse a Claude Code JSONL session.
 *
 * Claude Code writes one JSONL line per content block (thinking / text / tool_use) and repeats the same
 * `message.usage` on each, so summing lines overcounts ~3x. Responses are therefore keyed by `message.id`
 * and counted once.
 */
export function parseClaudeCode(/** @type {string} */ filePath, /** @type {any[]} */ objs) {
  const responses = new Map(); // message id -> response
  const toolUses = new Map(); // tool_use id -> { name, input }
  const callById = new Map(); // tool_use id -> the call object stored on its event (so the result can be attached)
  const userTurns = [];
  let lastTrigger = "typed"; // what began the stretch of work the next main-thread responses belong to
  const commandResults = [];
  const fileTouches = [];
  let usageLines = 0;
  let sessionId = path.basename(filePath, ".jsonl");

  for (const o of objs) {
    if (o.sessionId) sessionId = o.sessionId;
    const msg = o.message;
    if (!msg) continue;

    if (o.type === "assistant") {
      const u = msg.usage;
      if (u && msg.model !== "<synthetic>") {
        usageLines += 1;
        const id = msg.id || o.requestId || o.uuid;
        let r = responses.get(id);
        if (!r) {
          r = { id, ts: o.timestamp, model: msg.model, isSidechain: !!o.isSidechain, agentId: o.agentId, agentType: o.agentType, agentToolUseId: o.agentToolUseId, usage: emptyUsage(), tools: new Set(), calls: new Map(), trigger: lastTrigger };
          responses.set(id, r);
        }
        // Usage is repeated (and may grow while streaming): keep the largest value seen per field.
        const w5 = u.cache_creation?.ephemeral_5m_input_tokens;
        const w1 = u.cache_creation?.ephemeral_1h_input_tokens;
        const hasSplit = w5 != null || w1 != null;
        r.usage.input = max(r.usage.input, u.input_tokens);
        r.usage.cacheRead = max(r.usage.cacheRead, u.cache_read_input_tokens);
        r.usage.output = max(r.usage.output, u.output_tokens);
        r.usage.cacheWrite5m = max(r.usage.cacheWrite5m, hasSplit ? w5 : u.cache_creation_input_tokens);
        r.usage.cacheWrite1h = max(r.usage.cacheWrite1h, hasSplit ? w1 : 0);
      }
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b.type !== "tool_use") continue;
        toolUses.set(b.id, { name: b.name, input: b.input || {} });
        const r = responses.get(msg.id || o.requestId || o.uuid);
        if (r) {
          r.tools.add(b.name);
          const call = { id: b.id, name: b.name, sig: callSignature(b.name, b.input), file: typeof b.input?.file_path === "string" ? b.input.file_path : typeof b.input?.notebook_path === "string" ? b.input.notebook_path : undefined, ...(b.name === "Read" ? { partial: b.input?.offset != null || b.input?.limit != null } : {}) };
          r.calls.set(b.id, call);
          callById.set(b.id, call);
        }
        const file = b.input?.file_path || b.input?.notebook_path;
        if (file) fileTouches.push({ file, kind: WRITE_TOOLS.has(b.name) ? "write" : b.name === "Read" ? "read" : "other", id: b.id, ...(b.name === "Read" && Number.isFinite(b.input?.offset) ? { range: `${b.input.offset}-${b.input.offset + (Number.isFinite(b.input?.limit) ? b.input.limit : 2000) - 1}` } : {}) });
      }
      continue;
    }

    if (o.type === "user") {
      const content = msg.content;
      for (const b of Array.isArray(content) ? content : []) {
        if (b.type !== "tool_result") continue;
        const use = toolUses.get(b.tool_use_id);
        const text = typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((/** @type {any} */ c) => c.text || "").join("\n") : "";
        const imageChars = Array.isArray(b.content) ? b.content.filter((/** @type {any} */ c) => c.type === "image").length * 6000 : 0;
        const call = callById.get(b.tool_use_id);
        if (call) call.resChars = text.length + imageChars;
        // What came back, so "same call, same result, again" (no progress) can be told apart from a normal repeat.
        if (call) call.res = `${b.is_error === true ? "!" : ""}${crypto.createHash("sha1").update(text.slice(0, 400)).digest("hex").slice(0, 10)}`;
        if (use?.name !== "Bash") continue;
        const exit = text.match(/^Exit code (\d+)/);
        const ok = b.is_error !== true && !(exit && exit[1] !== "0");
        commandResults.push({ command: String(use.input.command || "").slice(0, 300), ok, summary: ok ? "" : text.split("\n").find((/** @type {any} */ l) => l.trim() && !/^Exit code/.test(l))?.trim().slice(0, 160) || "Non-zero exit" });
      }
      const text = userText(content);
      if (!o.isSidechain && text.trim()) lastTrigger = triggerOf(text, !!o.isMeta) ?? lastTrigger;
      if (!o.isSidechain && !o.isMeta && text.trim() && !NOT_TYPED.test(text)) userTurns.push({ text: text.trim().slice(0, 320), createdAt: o.timestamp });
    }
  }

  const events = [...responses.values()].map((r) => ({
    id: r.id,
    ts: r.ts,
    model: r.model,
    isSidechain: r.isSidechain,
    trigger: r.trigger,
    ...(r.agentId ? { agentId: r.agentId, agentType: r.agentType, agentToolUseId: r.agentToolUseId } : {}),
    usage: r.usage,
    context: contextTokens(r.usage),
    tools: [...r.tools],
    calls: [...r.calls.values()],
    confidence: CONFIDENCE.DERIVED
  }));

  return { agent: "claude-code", sessionId, transcriptPath: filePath, events, userTurns, commandResults, fileTouches, raw: { usageLines, uniqueResponses: events.length } };
}
