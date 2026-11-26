import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { handleMcpLine, MCP_TOOLS, MCP_VERSIONS } from "../src/mcp.mjs";
import { ROOT } from "./helpers.mjs";
import path from "node:path";

const report = { confidence: "derived", pricesAsOf: "2026-11-01", flowStatus: "ok", statusLevel: "ok", shouldStop: false, preActionAlert: null, tokens: { latestTurnContext: 1, total: 2, cacheReadRatio: 3 }, reReadFiles: [{ basename: "a.js", reads: 2, writes: 1 }], handoffPrompt: "H", sessionId: "s", realCostUSD: 1, nextTurnCostUSD: 0.1, potentialSavingsUSD: 0, touchedFiles: [] };
const calls = { sync: 0, reset: 0 };
const deps = (r = report) => ({ getReport: () => r, sync: () => calls.sync++, reset: () => calls.reset++ });
const send = (m, d = deps()) => {
  const out = handleMcpLine(typeof m === "string" ? m : JSON.stringify({ jsonrpc: "2.0", ...m }), d);
  return out === null ? null : JSON.parse(out);
};

test("notifications never get a reply, whatever the method; blank lines neither", () => {
  assert.equal(send({ method: "notifications/initialized" }), null);
  assert.equal(send({ method: "notifications/cancelled", params: { requestId: 1 } }), null);
  assert.equal(send({ method: "no/such/method" }), null, "an unknown method without an id is still a notification");
  assert.equal(handleMcpLine("   ", deps()), null);
});

test("ping, and initialize agreeing on a protocol version we know or offering our newest", () => {
  assert.deepEqual(send({ id: 1, method: "ping" }), { jsonrpc: "2.0", id: 1, result: {} });
  assert.equal(send({ id: 2, method: "initialize", params: { protocolVersion: "2024-11-05" } }).result.protocolVersion, "2024-11-05");
  assert.equal(send({ id: 3, method: "initialize", params: { protocolVersion: "1999-01-01" } }).result.protocolVersion, MCP_VERSIONS[0]);
  assert.equal(send({ id: 4, method: "initialize" }).result.serverInfo.name, "sparelimit-mcp");
});

test("error codes: parse error, invalid request, unknown method, invalid params (an unknown tool included)", () => {
  assert.equal(send("{not json").error.code, -32700);
  assert.equal(send("{not json").id, null);
  assert.equal(send('{"jsonrpc":"2.0","id":7}').error.code, -32600);
  assert.equal(send('{"jsonrpc":"2.0","id":7}').id, 7, "the id is kept when it can be read");
  assert.equal(send("[1,2]").error.code, -32600);
  assert.equal(send({ id: 8, method: "resources/list" }).error.code, -32601);
  assert.equal(send({ id: 9, method: "tools/call", params: { name: "nope" } }).error.code, -32602);
  assert.equal(send({ id: 10, method: "tools/call", params: {} }).error.code, -32602);
  assert.equal(send({ id: 11, method: "tools/call", params: { name: "sparelimit_check_guardrail", arguments: { target_file: 5 } } }).error.code, -32602);
  assert.equal(send({ id: 12, method: "tools/call", params: { name: "sparelimit_check_guardrail", arguments: { surprise: 1 } } }).error.code, -32602);
  assert.equal(send({ id: 13, method: "tools/call", params: { name: "sparelimit_check_guardrail", arguments: [] } }).error.code, -32602);
});

test("a tool that cannot do its job says so with isError inside a normal result; the three tools run; only the reset acts", () => {
  const none = send({ id: 1, method: "tools/call", params: { name: "sparelimit_get_telemetry" } }, deps(null));
  assert.equal(none.result.isError, true);
  assert.equal(none.error, undefined);
  const boom = send({ id: 2, method: "tools/call", params: { name: "sparelimit_get_telemetry" } }, { ...deps(), getReport: () => { throw new Error("unreadable"); } });
  assert.match(boom.result.content[0].text, /unreadable/);
  assert.equal(boom.result.isError, true);
  const g = send({ id: 3, method: "tools/call", params: { name: "sparelimit_check_guardrail", arguments: { target_file: "a.js" } } });
  assert.equal(JSON.parse(g.result.content[0].text).churned_files[0], "a.js (2r/1w)");
  assert.equal(g.result.isError, undefined);
  const tel = JSON.parse(send({ id: 4, method: "tools/call", params: { name: "sparelimit_get_telemetry" } }).result.content[0].text);
  assert.deepEqual(Object.keys(tel.confidence).sort(), ["accumulatedCostUSD", "cacheReadRatioPct", "nextTurnCostUSD", "potentialSavingsUSD", "totalTokens"], "every figure carries a label (A16)");
  assert.equal(tel.confidence.nextTurnCostUSD, "estimated");
  assert.equal(JSON.parse(g.result.content[0].text).confidence.active_context_tokens, "derived");
  assert.equal(calls.reset, 0, "the read-only tools never reset");
  const r = send({ id: 5, method: "tools/call", params: { name: "sparelimit_request_reset" } });
  assert.equal(calls.reset, 1);
  assert.match(r.result.content[0].text, /Handoff prompt/);
  const bad = send({ id: 6, method: "tools/call", params: { name: "sparelimit_request_reset" } }, { ...deps(), reset: () => { throw new Error("disk full"); } });
  assert.equal(bad.result.isError, true);
});

test("tools declare whether they read or act, and each takes an object with no extra properties", () => {
  const listed = send({ id: 1, method: "tools/list" }).result.tools;
  assert.deepEqual(listed.map((t) => [t.name, t.annotations.readOnlyHint]), [["sparelimit_check_guardrail", true], ["sparelimit_get_telemetry", true], ["sparelimit_request_reset", false]]);
  for (const t of MCP_TOOLS) assert.equal(t.inputSchema.additionalProperties, false);
});

test("over a real stdio pipe: replies come one per request and a notification in between adds none", () => {
  const input = [{ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, { method: "notifications/initialized" }, { id: 2, method: "ping" }].map((m) => JSON.stringify({ jsonrpc: "2.0", ...m })).join("\n") + "\n";
  const r = spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), "mcp"], { input, encoding: "utf8", timeout: 15000, env: { ...process.env, SPARELIMIT_HOME: path.join(ROOT, "tests", "fixtures", "no-home") } });
  const lines = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.id), [1, 2]);
  assert.equal(lines[0].result.protocolVersion, "2025-03-26");
});
