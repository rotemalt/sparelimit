/** The live watcher and the MCP server. Split out of sparelimit.mjs (A11). */
import readline from "node:readline";
import { VERSION } from "./constants.mjs";
import { analyzeTranscript, executeReset, notifyOS, printTerminalHUD, syncStatusFiles } from "./report.mjs";
import { discoverTranscripts } from "./transcripts.mjs";

/**
 * Live Watcher Loop (Daemon)
 */
/**
 * @param {string | undefined} customPath
 * @param {string | null} [modelKey]
 */
export function startWatcher(customPath, modelKey = null) {
  console.log(`\n⚡ sparelimit Watcher active. Monitoring local sessions...`);
  console.log(`Press Ctrl+C to exit.\n`);

  let lastStatus = "";
  let lastMtime = 0;

  const tick = () => {
    const discovered = discoverTranscripts(customPath);
    if (discovered.length === 0) return;

    const latest = discovered[0];
    if (latest.mtimeMs === lastMtime) return;
    lastMtime = latest.mtimeMs;

    const report = analyzeTranscript(latest.filePath, modelKey);
    syncStatusFiles(report);

    if (report.statusLevel !== lastStatus) {
      if (report.statusLevel === "critical") {
        notifyOS(
          "🚨 sparelimit: Reset Recommended",
          `Active context is ${(report.tokens.latestTurnContext / 1000).toFixed(1)}k tokens. Reset thread now.`
        );
      } else if (report.statusLevel === "warn") {
        notifyOS(
          "⚠️ sparelimit: Context Drift",
          `Context reached ${(report.tokens.latestTurnContext / 1000).toFixed(1)}k tokens.`
        );
      }
      lastStatus = report.statusLevel;
    }

    printTerminalHUD(report);
  };

  tick();
  setInterval(tick, 2000);
}

/**
 * MCP server (JSON-RPC 2.0 over stdio, one message per line), written to the spec's rules (C8):
 *   - a message without an `id` is a notification and never gets a reply, whatever the method;
 *   - `ping` answers with an empty result; `initialize` agrees on a protocol version we know, else offers our newest;
 *   - bad JSON is -32700, a message that is not a request object -32600, an unknown method -32601, bad parameters -32602 (an unknown tool
 *     name included, as the spec says);
 *   - a tool that ran but could not do its job (no transcript yet) answers with `isError: true` inside a normal result, so the agent sees it;
 *   - tools say whether they only read (`readOnlyHint`) or act (`sparelimit_request_reset` writes a handoff file and the clipboard).
 */
export const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const MCP_TOOLS = [
  {
    name: "sparelimit_check_guardrail",
    description: "Check if coding agent should halt due to context saturation, doom-loop churn, or excessive cost. Read-only.",
    inputSchema: { type: "object", properties: { target_file: { type: "string", description: "Optional target file being modified" } }, additionalProperties: false },
    annotations: { title: "Check the guardrail", readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "sparelimit_get_telemetry",
    description: "Get full real-time session telemetry including token breakdown, costs, and churned files. Read-only.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Session telemetry", readOnlyHint: true, openWorldHint: false }
  },
  {
    name: "sparelimit_request_reset",
    description: "Trigger surgical context reset and generate 1-shot handoff prompt for fresh chat. Acts: writes the handoff file and copies it to the clipboard.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { title: "Reset with a handoff", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }
];

const ok = (/** @type {any} */ id, /** @type {any} */ result) => ({ jsonrpc: "2.0", id, result });
const fail = (/** @type {any} */ id, /** @type {number} */ code, /** @type {string} */ message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const text = (/** @type {string} */ t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

/**
 * One line in, the reply line out (or null when none is due).
 * @param {string} line
 * @param {{ getReport: () => any, sync: (report: any) => void, reset: (report: any) => void }} deps
 * @returns {string | null}
 */
export function handleMcpLine(line, deps) {
  if (!line.trim()) return null;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return JSON.stringify(fail(null, -32700, "Parse error"));
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg) || typeof msg.method !== "string" || msg.jsonrpc !== "2.0") {
    return JSON.stringify(fail(msg && typeof msg === "object" && !Array.isArray(msg) && (typeof msg.id === "string" || typeof msg.id === "number") ? msg.id : null, -32600, "Invalid Request"));
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return null; // a notification: no reply, ever
  const reply = (/** @type {any} */ r) => JSON.stringify(r);

  if (method === "ping") return reply(ok(id, {}));

  if (method === "initialize") {
    const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
    return reply(ok(id, {
      protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "sparelimit-mcp", version: VERSION }
    }));
  }

  if (method === "tools/list") return reply(ok(id, { tools: MCP_TOOLS }));

  if (method === "tools/call") {
    if (!params || typeof params !== "object" || typeof params.name !== "string") return reply(fail(id, -32602, "Invalid params: `name` (a tool name) is required"));
    const tool = MCP_TOOLS.find((t) => t.name === params.name);
    if (!tool) return reply(fail(id, -32602, `Unknown tool: ${params.name}`));
    const args = params.arguments ?? {};
    if (typeof args !== "object" || Array.isArray(args)) return reply(fail(id, -32602, "Invalid params: `arguments` must be an object"));
    if (args.target_file !== undefined && typeof args.target_file !== "string") return reply(fail(id, -32602, "Invalid params: `target_file` must be a string"));
    const extra = Object.keys(args).filter((k) => !(k in tool.inputSchema.properties));
    if (extra.length) return reply(fail(id, -32602, `Invalid params: unexpected argument ${extra.join(", ")}`));

    let report;
    try {
      report = deps.getReport();
    } catch (err) {
      return reply(ok(id, text(`Could not read the transcript: ${err instanceof Error ? err.message : String(err)}`, true)));
    }
    if (!report) return reply(ok(id, text("No active transcript found. Start or continue a Claude Code session in this project, then call again.", true)));
    deps.sync(report);

    if (params.name === "sparelimit_check_guardrail") {
      return reply(ok(id, text(JSON.stringify({
        status: report.flowStatus,
        statusLevel: report.statusLevel,
        should_stop: report.shouldStop,
        pre_action_alert: report.preActionAlert,
        active_context_tokens: report.tokens.latestTurnContext,
        confidence: { active_context_tokens: report.confidence, should_stop: report.confidence },
        churned_files: report.reReadFiles.map((/** @type {any} */ f) => `${f.basename} (${f.reads}r/${f.writes}w)`),
        handoff_prompt: report.handoffPrompt
      }, null, 2))));
    }
    if (params.name === "sparelimit_get_telemetry") {
      return reply(ok(id, text(JSON.stringify({
        sessionId: report.sessionId,
        accumulatedCostUSD: report.realCostUSD,
        totalTokens: report.tokens.total,
        cacheReadRatioPct: report.tokens.cacheReadRatio,
        nextTurnCostUSD: report.nextTurnCostUSD,
        potentialSavingsUSD: report.potentialSavingsUSD,
        // exact = the app's own usage numbers, derived = summed from the log, estimated = needs an assumption (what the next turn or a reset would cost)
        confidence: { accumulatedCostUSD: report.confidence, totalTokens: report.confidence, cacheReadRatioPct: report.confidence, nextTurnCostUSD: "estimated", potentialSavingsUSD: report.savingsConfidence || "estimated" },
        pricesAsOf: report.pricesAsOf,
        touchedFiles: report.touchedFiles
      }, null, 2))));
    }
    try {
      deps.reset(report);
    } catch (err) {
      return reply(ok(id, text(`The reset could not be completed: ${err instanceof Error ? err.message : String(err)}`, true)));
    }
    return reply(ok(id, text(`Reset protocol executed. Handoff prompt: \n${report.handoffPrompt}`)));
  }

  return reply(fail(id, -32601, `Method not found: ${method}`));
}

/**
 * @param {string | undefined} customPath
 * @param {string | null} [modelKey]
 */
export function startMcpServer(customPath, modelKey = null) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  const deps = {
    getReport: () => {
      const latest = discoverTranscripts(customPath)[0];
      return latest ? analyzeTranscript(latest.filePath, modelKey) : null;
    },
    sync: syncStatusFiles,
    reset: executeReset
  };
  rl.on("line", (line) => {
    const out = handleMcpLine(line, deps);
    if (out) process.stdout.write(out + "\n");
  });
}
