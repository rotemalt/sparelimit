import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { looksLikeCodex, parseCodex, codexUsage } from "../src/adapters/codex.mjs";
import { parseTranscript } from "../src/adapters/index.mjs";
import { summarizeCodex } from "../src/codexreport.mjs";
import { codexSessionFiles, isCodexLog, isClaudeLog } from "../src/sources.mjs";
import { loadPricing } from "../src/pricing.mjs";

const T = (min) => new Date(Date.parse("2026-11-05T10:00:00Z") + min * 60e3).toISOString();
const meta = (extra = {}) => ({ timestamp: T(0), ordinal: 0, type: "session_meta", payload: { id: "sess-codex", cli_version: "0.165.0", originator: "codex", cwd: "/Users/x/Proj", source: "cli", ...extra } });
const ctx = (model, min = 0) => ({ timestamp: T(min), type: "turn_context", payload: { model } });
const rec = (id, min, u) => ({ timestamp: T(min), ordinal: min, type: "token_usage_record", payload: { response_id: id, usage: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, ...u } } });
const tcount = (min, last, total) => ({ timestamp: T(min), ordinal: min, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total }, rate_limits: { primary: { used_percent: 40, window_minutes: 300 } } } });
const call = (id, name, args) => ({ timestamp: T(1), type: "response_item", payload: { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) } });
const out = (id, output) => ({ timestamp: T(2), type: "response_item", payload: { type: "function_call_output", call_id: id, output } });
const msg = (role, text) => ({ timestamp: T(1), type: "response_item", payload: { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });

test("the log is recognised by its session_meta; a Claude Code line is not Codex", () => {
  assert.equal(looksLikeCodex([meta()]), true);
  assert.equal(looksLikeCodex([{ type: "assistant", message: {}, uuid: "u" }]), false);
  assert.equal(looksLikeCodex([]), false);
});

test("usage: input_tokens includes the cached part, so uncached input is the difference; output includes reasoning; context is the whole prompt", () => {
  assert.deepEqual(codexUsage({ input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50, reasoning_output_tokens: 30 }), { input: 100, cacheRead: 900, cacheWrite5m: 0, cacheWrite1h: 0, output: 50 });
  assert.deepEqual(codexUsage({ input_tokens: 100, cached_input_tokens: 500 }).input, 0, "cached cannot exceed input");
  assert.equal(codexUsage({ input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 100 }).input, 300, "a cache write, if ever reported, is part of the input");
  assert.deepEqual(codexUsage(null), { input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 });
  const s = parseCodex("/x/rollout-1.jsonl", [meta(), ctx("gpt-6.1-sol"), rec("r1", 1, { input_tokens: 1000, cached_input_tokens: 900, output_tokens: 50 })]);
  assert.equal(s.events[0].context, 1000);
});

test("records are preferred and counted once per response id; a record with no usable figures is skipped; the model is the last turn_context", () => {
  const s = parseCodex("/x/rollout-1.jsonl", [meta(), ctx("gpt-6.1-sol", 0), rec("r1", 1, { input_tokens: 100, output_tokens: 10 }), rec("r1", 1, { input_tokens: 100, output_tokens: 10 }), ctx("gpt-6-astra", 2), rec("r2", 3, { input_tokens: 200, output_tokens: 20 }), rec("r3", 4, {}), tcount(5, { input_tokens: 999 }, { input_tokens: 999 })]);
  assert.deepEqual(s.events.map((e) => [e.id, e.model, e.context]), [["r1", "gpt-6.1-sol", 100], ["r2", "gpt-6-astra", 200]]);
  assert.equal(s.raw.source, "token_usage_record");
  assert.deepEqual(s.raw.rateLimits, { primary: { used_percent: 40, window_minutes: 300 } }, "the plan limits Codex reports are kept, not used yet");
});

test("without records, token_count events are the source, and an unchanged running total is not counted twice", () => {
  const a = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 10 };
  const b = { input_tokens: 300, cached_input_tokens: 200, output_tokens: 20 };
  const s = parseCodex("/x/rollout-1.jsonl", [meta(), ctx("gpt-6.1-sol"), tcount(1, a, a), tcount(2, a, a), tcount(3, b, { input_tokens: 400, cached_input_tokens: 240, output_tokens: 30 })]);
  assert.equal(s.events.length, 2);
  assert.equal(s.raw.source, "token_count");
  assert.deepEqual(s.events.map((e) => e.usage.cacheRead), [40, 200]);
});

test("a call comes before its response's usage record, so it attaches to the next record; its output fills in the size and failure", () => {
  const s = parseCodex("/x/rollout-1.jsonl", [
    meta(), ctx("gpt-6.1-sol"),
    call("c1", "exec", { cmd: "npm test" }), rec("r1", 1, { input_tokens: 100, output_tokens: 5 }), out("c1", "Error: 3 tests failed"),
    call("c2", "exec", { cmd: "ls" }), rec("r2", 2, { input_tokens: 150, output_tokens: 5 }), out("c2", "a b c")
  ]);
  assert.deepEqual(s.events.map((e) => e.tools), [["exec"], ["exec"]]);
  const [c1, c2] = s.events.map((e) => e.calls[0]);
  assert.equal(c1.resChars, 21);
  assert.ok(c1.res.startsWith("!"), "a failure is marked the way the Claude adapter marks it");
  assert.ok(!c2.res.startsWith("!"));
  assert.notEqual(c1.sig, c2.sig);
  assert.deepEqual(s.commandResults.map((c) => [c.command, c.ok]), [["npm test", false], ["ls", true]]);
});

test("what the person typed is a user turn; context the CLI injects (tagged messages) and the assistant's words are not", () => {
  const s = parseCodex("/x/rollout-1.jsonl", [meta(), msg("user", "<environment_context>cwd</environment_context>"), msg("user", "fix the login bug"), msg("assistant", "done"), msg("developer", "x")]);
  assert.deepEqual(s.userTurns.map((u) => u.text), ["fix the login bug"]);
});

test("a subagent session is flagged and named by its working folder; it is its own session", () => {
  const s = parseCodex("/x/rollout-1.jsonl", [meta({ source: { subagent: { other: "x" } } })]);
  assert.equal(s.subagent, true);
  assert.equal(s.projectDir, "/Users/x/Proj");
  assert.equal(parseCodex("/x/rollout-1.jsonl", [meta()]).subagent, false);
});

test("parseTranscript routes a Codex file to this adapter, and the report prices by model, separating models missing from the price list", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-codex-"));
  const f = path.join(dir, "rollout-1.jsonl");
  fs.writeFileSync(f, [meta(), ctx("gpt-5"), rec("r1", 1, { input_tokens: 1e6, cached_input_tokens: 0, output_tokens: 0 }), ctx("totally-unknown-model", 2), rec("r2", 3, { input_tokens: 1e6, output_tokens: 0 })].map((o) => JSON.stringify(o)).join("\n") + "\n");
  const s = parseTranscript(f);
  assert.equal(s.agent, "codex");
  const sum = summarizeCodex([s], { pricing: loadPricing(), now: Date.parse("2026-11-06T00:00:00Z") });
  assert.equal(sum.sessions, 1);
  assert.equal(sum.responses, 2);
  assert.ok(sum.totalUSD > 0);
  assert.ok(sum.unpricedUSD > 0 && sum.unpricedUSD < sum.totalUSD, "only the unknown model's share is estimated");
  assert.deepEqual(sum.byModel.map((m) => [m.model, m.priced]).sort(), [["gpt-5", true], ["totally-unknown-model", false]]);
  assert.match(sum.confidence, /estimated/);
  assert.equal(sum.tokens.cacheReadShare, 0);
  assert.equal(summarizeCodex([], { pricing: loadPricing() }).sessions, 0);
});

test("discovery: date-folder rollout files only (plain JSONL), and Codex logs are not Claude logs", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-cx-"));
  const day = path.join(home, ".codex", "sessions", "2026", "11", "05");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, "rollout-a.jsonl"), "{}\n");
  fs.writeFileSync(path.join(day, "rollout-b.jsonl.zst"), "x");
  fs.writeFileSync(path.join(day, "notes.jsonl"), "{}\n");
  const files = codexSessionFiles({ home, env: {} });
  assert.deepEqual(files.map((f) => path.basename(f)), ["rollout-a.jsonl"]);
  assert.equal(isCodexLog(files[0]), true);
  assert.equal(isClaudeLog(files[0]), false);
  assert.equal(isClaudeLog("/Users/a/.claude/projects/p/x.jsonl"), true);
  assert.deepEqual(codexSessionFiles({ home: path.join(home, "none"), env: {} }), []);
});

test("the newest plan-limit reading Codex logged is reported with its time and labelled exact; a window of another length is not taken for the 5-hour one", () => {
  const mk = (min, p5, w5 = 300) => parseCodex("/x/rollout-1.jsonl", [meta(), ctx("gpt-5"), rec("r", min, { input_tokens: 10 }), { timestamp: T(min), ordinal: min, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: {}, total_token_usage: {} }, rate_limits: { primary: { used_percent: p5, window_minutes: w5 }, secondary: { used_percent: 12, window_minutes: 10080 } } } }]);
  const sum = summarizeCodex([mk(1, 20), mk(9, 74), mk(5, 50)], { pricing: loadPricing() });
  assert.deepEqual({ at: sum.planLimits.at, fiveHourPct: sum.planLimits.fiveHourPct, weeklyPct: sum.planLimits.weeklyPct, confidence: sum.planLimits.confidence }, { at: T(9), fiveHourPct: 74, weeklyPct: 12, confidence: "exact: reported by Codex in its own log" });
  assert.equal(sum.planLimits.forecast.fiveHour, null, "no reset time in the readings, so nothing to forecast against");
  assert.equal(summarizeCodex([mk(1, 20, 60)], { pricing: loadPricing() }).planLimits.fiveHourPct, null);
  assert.equal(summarizeCodex([parseCodex("/x/r.jsonl", [meta(), rec("r", 1, { input_tokens: 5 })])], { pricing: loadPricing() }).planLimits, null);
});

test("subagents are grouped under the conversation that started them, through parents up to ten levels; orphans and loops stay conversations of their own", () => {
  const sess = (id, parent, usd, extra = {}) => parseCodex(`/x/rollout-${id}.jsonl`, [meta({ id, parent_thread_id: parent, source: parent ? { subagent: {} } : "cli", cwd: `/p/${id}` }), ctx("gpt-5"), rec(`r-${id}`, 1, { input_tokens: usd * 1e6 / 1.25, output_tokens: 0, ...extra })]);
  const root = sess("root", null, 10);
  const kidA = sess("kidA", "root", 2);
  const kidB = sess("kidB", "root", 4);
  const grand = sess("grand", "kidA", 1);
  const orphan = sess("orphan", "not-in-the-logs", 3);
  const sum = summarizeCodex([grand, kidB, orphan, root, kidA], { pricing: loadPricing() });
  assert.equal(sum.conversations, 2, "the family and the orphan");
  assert.equal(sum.fanOut.subagentSessions, 3, "a grandchild counts under the root, not under its parent");
  const fam = sum.top.find((t) => t.id === root.sessionId);
  assert.equal(fam.subagents, 3);
  assert.ok(Math.abs(fam.subagentUSD - 7) < 0.02, "2 + 4 + 1");
  assert.ok(Math.abs(fam.totalUSD - 17) < 0.02);
  assert.equal(sum.top[0].id, root.sessionId, "ranked by what the whole conversation cost");
  assert.equal(sum.fanOut.widest.subagents, 3);
  assert.equal(sum.fanOut.shareOfSpend, Math.round((7 / 20) * 1000) / 10);
  const a = sess("a", "b", 1), b = sess("b", "a", 1);
  assert.equal(summarizeCodex([a, b], { pricing: loadPricing() }).sessions, 2, "a loop of parents does not hang or lose sessions");
});

test("dashboard: /api/codex returns the summary when Codex sessions exist and 503 when there are none; the card renders text only", async () => {
  const { startServer } = await import("../sparelimit.mjs");
  const saved = { HOME: process.env.HOME, V: process.env.SPARELIMIT_HOME };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-cxsrv-"));
  process.env.HOME = home;
  process.env.SPARELIMIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-state-"));
  const server = startServer(null, null, 0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/api/codex`)).status, 503, "no Codex sessions");
    const day = path.join(home, ".codex", "sessions", "2026", "11", "05");
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, "rollout-x.jsonl"), [meta(), ctx("gpt-5"), rec("r1", 1, { input_tokens: 1e6, output_tokens: 1000 })].map((o) => JSON.stringify(o)).join("\n") + "\n");
    server.close();
    const server2 = startServer(null, null, 0);
    await new Promise((r) => server2.once("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${server2.address().port}/api/codex`);
      assert.equal(res.status, 200);
      const j = await res.json();
      assert.equal(j.conversations, 1);
      assert.ok(j.totalUSD > 0);
      assert.equal(j.fanOut.subagentSessions, 0);
    } finally {
      server2.close();
    }
  } finally {
    server.close();
    for (const [k, v] of [["HOME", saved.HOME], ["SPARELIMIT_HOME", saved.V]]) v == null ? delete process.env[k] : (process.env[k] = v);
  }
  const app = fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "..", "app.js"), "utf8");
  const codexPart = app.slice(app.indexOf("async function initCodex"));
  assert.doesNotMatch(codexPart, /innerHTML|insertAdjacentHTML|document\.write/, "text only, no markup from data");
});

test("the pace comes from the running maximum within one limit window: another session's older snapshot is not a reset", async () => {
  const { codexPace } = await import("../src/codexreport.mjs");
  const now = 10_000_000;
  const at = (min, fh, reset = 1) => ({ t: now - (30 - min) * 60e3, fh, sd: null, fhReset: reset, sdReset: null });
  // 10% to 40% over 25 minutes, with a stale reading in the middle (a lower number later in time)
  const s = [at(0, 10), at(5, 20), at(10, 18), at(15, 30), at(20, 28), at(25, 40)];
  assert.equal(codexPace(s, "fh", "fhReset", now), 72, "30 points in 25 minutes");
  assert.equal(codexPace([at(0, 10, 1), at(25, 5, 2)], "fh", "fhReset", now), null, "readings of an earlier window are not mixed in");
  assert.equal(codexPace([at(24, 10), at(25, 12)], "fh", "fhReset", now), null, "under five minutes between readings");
  assert.equal(codexPace([at(25, 12)], "fh", "fhReset", now), null);
  assert.equal(codexPace([], "fh", "fhReset", now), null);
});

test("forecast: a recent pace gives 'runs out before the reset'; no reading is invented once a window has reset; a barely started window is not projected", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  const reset5 = (now + 120 * 60e3) / 1000; // 2 hours left of 5: 3 hours in
  const resetW = (now + 6.9 * 86400e3) / 1000; // a week that started 2.4 hours ago
  const mk = (readings) => parseCodex("/x/rollout-1.jsonl", [meta(), ctx("gpt-5"), rec("r", 1, { input_tokens: 10 }), ...readings.map(([min, fh, sd], i) => ({ timestamp: new Date(now - min * 60e3).toISOString(), ordinal: i + 10, type: "event_msg", payload: { type: "token_count", info: { last_token_usage: {}, total_token_usage: {} }, rate_limits: { primary: { used_percent: fh, window_minutes: 300, resets_at: reset5 }, secondary: { used_percent: sd, window_minutes: 10080, resets_at: resetW } } } }))]);
  const s = mk([[20, 40, 5], [10, 50, 6], [1, 60, 7]]);
  const sum = summarizeCodex([s], { pricing: loadPricing(), now });
  const f = sum.planLimits.forecast;
  assert.equal(f.fiveHour.ratePctPerHour, 63.2, "20 points in 19 minutes");
  assert.equal(f.fiveHour.lastsUntilReset, false);
  assert.ok(f.fiveHour.minutesToLimit < 120);
  assert.equal(f.weekly.basis, "too early in the window to project");
  assert.equal(f.weekly.minutesToLimit, null);
  assert.equal(f.windowResetSinceReading, false);
  // a reading from before the 5-hour window reset
  const old = summarizeCodex([s], { pricing: loadPricing(), now: now + 3 * 3600e3 }).planLimits.forecast;
  assert.equal(old.windowResetSinceReading, true);
  assert.equal(old.fiveHour, null);
  // an old reading has no recent pace: the window average is used instead
  const stale = summarizeCodex([s], { pricing: loadPricing(), now: now + 60 * 60e3 }).planLimits.forecast;
  assert.equal(stale.ageMin, 61);
  assert.equal(stale.fiveHour.basis, "window average");
});
