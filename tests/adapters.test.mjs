import test from "node:test";
import assert from "node:assert/strict";
import { parseTranscript } from "../src/adapters/index.mjs";
import { fixture } from "./helpers.mjs";

test("Claude Code: counts each API response once, not once per content-block line", () => {
  const s = parseTranscript(fixture("claude-code-session.jsonl"));
  assert.equal(s.agent, "claude-code");
  assert.equal(s.raw.usageLines, 6); // 3 + 2 + 1 lines carrying usage (synthetic error line excluded)
  assert.equal(s.events.length, 3);
  const cacheRead = s.events.reduce((n, e) => n + e.usage.cacheRead, 0);
  assert.equal(cacheRead, 5000 + 6000 + 6200); // naive line-summing would give 33,200
});

test("Claude Code: splits cache writes by TTL and records tools and models", () => {
  const s = parseTranscript(fixture("claude-code-session.jsonl"));
  const a = s.events[0];
  assert.deepEqual([a.usage.cacheWrite5m, a.usage.cacheWrite1h], [0, 1000]);
  assert.deepEqual(a.tools, ["Read"]);
  assert.equal(s.events[2].model, "claude-haiku-5-5");
  assert.equal(a.context, 10 + 1000 + 5000);
});

test("Claude Code: user turns exclude tool results, meta and system reminders", () => {
  const s = parseTranscript(fixture("claude-code-session.jsonl"));
  assert.deepEqual(s.userTurns.map((t) => t.text), ["fix the failing build", "run the tests again"]);
});

test("Claude Code: failed Bash results and file touches are extracted", () => {
  const s = parseTranscript(fixture("claude-code-session.jsonl"));
  assert.equal(s.commandResults.length, 1);
  assert.equal(s.commandResults[0].ok, false);
  assert.equal(s.commandResults[0].summary, "FAIL tests/a.test.js");
  assert.deepEqual(s.fileTouches.map((f) => [f.file, f.kind]), [["/p/a.js", "read"]]);
});

test("Antigravity: detects the selected model from the settings-change note", () => {
  const s = parseTranscript(fixture("antigravity-session.jsonl"));
  assert.equal(s.agent, "antigravity");
  assert.equal(s.declaredModel, "Gemini 3.8 Flash (High)");
  assert.equal(s.events.length, 2);
  assert.equal(s.commandResults.length, 1);
});

test("unknown formats return null instead of guessing", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = `${os.tmpdir()}/sparelimit-unknown-${process.pid}.jsonl`;
  fs.writeFileSync(p, '{"hello":"world"}\n');
  assert.equal(parseTranscript(p), null);
  fs.unlinkSync(p);
});

test("Claude Code: subagent logs under <session>/subagents are read as sidechain spend, de-duplicated by message id", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-sub-"));
  const main = path.join(dir, "11111111-1111-1111-1111-111111111111.jsonl");
  fs.copyFileSync(fixture("claude-code-session.jsonl"), main);
  fs.mkdirSync(path.join(dir, "11111111-1111-1111-1111-111111111111", "subagents"), { recursive: true });
  const sub = (id, out) => JSON.stringify({ type: "assistant", sessionId: "11111111-1111-1111-1111-111111111111", timestamp: "2026-11-05T10:00:09Z", uuid: id + "u", message: { id, model: "claude-sonnet-5-5", role: "assistant", content: [{ type: "text", text: "sub" }], usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000, output_tokens: out } } });
  fs.writeFileSync(path.join(dir, "11111111-1111-1111-1111-111111111111", "subagents", "agent-1.jsonl"), [sub("msg_S1", 40), sub("msg_S1", 40), sub("msg_S2", 60)].join("\n") + "\n");
  const s = parseTranscript(main);
  assert.equal(s.raw.subagentFiles, 1);
  assert.equal(s.events.length, 5); // 3 main + 2 unique subagent responses (msg_S1 logged twice)
  assert.equal(s.events.filter((e) => e.isSidechain).length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
