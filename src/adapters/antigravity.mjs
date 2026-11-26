import path from "node:path";
import { emptyUsage, contextTokens, callSignature, CONFIDENCE } from "../schema.mjs";

export function looksLikeAntigravity(/** @type {any[]} */ objs) {
  return objs.some((/** @type {any} */ o) => typeof o.step_index === "number" && (o.source === "MODEL" || o.source === "USER_EXPLICIT" || o.type === "PLANNER_RESPONSE"));
}

/**
 * Antigravity does not store the model on each step; it logs a `USER_SETTINGS_CHANGE` note when the model
 * is selected ("... changed setting `Model Selection` from X to Gemini 3.8 Flash (High)"). Use the last one.
 */
function detectModel(/** @type {any[]} */ objs) {
  let model = null;
  for (const o of objs) {
    const m = typeof o.content === "string" && o.content.match(/changed setting `Model Selection` from [^`]*? to ([^\n<]+?)(?:\.(?:\s|$)|\n|<|$)/);
    if (m) model = m[1].trim();
  }
  return model;
}

export function parseAntigravity(/** @type {string} */ filePath, /** @type {any[]} */ objs) {
  const model = detectModel(objs);
  const events = [];
  const userTurns = [];
  const commandResults = [];
  const fileTouches = [];

  for (const o of objs) {
    if (o.type === "USER_INPUT") {
      let text = String(o.content || "");
      const m = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
      if (m) text = m[1].trim();
      if (text) userTurns.push({ text: text.slice(0, 320), createdAt: o.created_at });
    } else if (o.type === "PLANNER_RESPONSE") {
      const usage = { ...emptyUsage(), input: Number(o.input_tokens || 0), cacheRead: Number(o.cache_read_tokens || 0), output: Number(o.output_tokens || 0) };
      const calls = Array.isArray(o.tool_calls) ? o.tool_calls : [];
      for (const c of calls) {
        let args = c.args || {};
        if (typeof args === "string") {
          try {
            args = JSON.parse(args);
          } catch {
            args = {};
          }
        }
        const file = String(args.Path || args.file_path || "").replace(/^"|"$/g, "");
        if (file) fileTouches.push({ file, kind: /write|edit/.test(c.name) ? "write" : /read/.test(c.name) ? "read" : "other" });
      }
      events.push({ id: `step-${o.step_index}`, ts: o.created_at, model, isSidechain: false, usage, context: contextTokens(usage), tools: calls.map((/** @type {any} */ c) => c.name), calls: calls.map((/** @type {any} */ c) => ({ name: c.name, sig: callSignature(c.name, typeof c.args === "string" ? c.args : c.args || {}) })), confidence: model ? CONFIDENCE.DERIVED : CONFIDENCE.ESTIMATED, stepIndex: o.step_index });
    } else if (o.type === "GENERIC" && typeof o.content === "string") {
      const m = o.content.match(/Command exited with code (\d+)/);
      if (m) {
        const ok = m[1] === "0";
        commandResults.push({ command: "", ok, summary: ok ? "" : o.content.split("\n").find((/** @type {any} */ l) => /Error|failed|exited with code/.test(l))?.trim().slice(0, 160) || "Non-zero exit" });
      }
    }
  }

  // sessionId = folder name two levels above `.system_generated/logs/transcript.jsonl`
  const sessionId = path.basename(path.dirname(path.dirname(path.dirname(filePath))));
  return { agent: "antigravity", sessionId, transcriptPath: filePath, events, userTurns, commandResults, fileTouches, raw: { lines: objs.length, usageLines: events.length, uniqueResponses: events.length }, declaredModel: model };
}
