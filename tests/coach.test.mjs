import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { coldCacheAdvice, lastTurn, readTail } from "../src/coach.mjs";
import { handleHook } from "../src/hook.mjs";
import { auditPath, configPath, probePath, snapshotPath, writeJsonAtomic } from "../src/state.mjs";
import { calibrationPath } from "../src/planestimate.mjs";
import { tempSparelimitHome } from "./helpers.mjs";

const NOW = Date.parse("2026-11-05T15:00:00Z");
const iso = (agoMin) => new Date(NOW - agoMin * 60e3).toISOString();
const asst = (agoMin, ctx, { model = "claude-sonnet-5-5", side = false, ttl1h = 1000 } = {}) =>
  JSON.stringify({ type: "assistant", sessionId: "s", timestamp: iso(agoMin), isSidechain: side, message: { id: `m${agoMin}${ctx}`, model, usage: { input_tokens: 5, cache_read_input_tokens: ctx - 5 - ttl1h, cache_creation_input_tokens: ttl1h, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: ttl1h }, output_tokens: 100 } } });
const req = (ttl) => JSON.stringify({ type: "api-request", sessionId: "s", cacheControl: [{ path: ["system", 1], value: { type: "ephemeral", ttl } }] });
const tailOf = (...lines) => lines.join("\n") + "\n";

test("cold 1-hour cache on a big conversation: says what resuming costs, what a fresh start costs, and the share of the limit", () => {
  const tail = tailOf(req("1h"), asst(200, 60_000), asst(90, 400_000));
  const cal = { points: [{ fivePct: 97, spendFive: 28.47 }] };
  const a = coldCacheAdvice({ now: NOW, tail, calibration: cal });
  assert.equal(a.rule, "cache.cold");
  assert.equal(a.evidence.resumeUSD, 1.6); // 400k tokens x $4 per M (1-hour write, Sonnet 5.5)
  assert.equal(a.evidence.freshUSD, 0.36); // (60k smallest context seen + 4k handoff + 25k re-read) x $4 per M
  assert.equal(a.evidence.gapMin, 90);
  assert.match(a.message, /went cold after 90 min/);
  assert.match(a.message, /about \$1\.60 \(about 5% of your 5-hour limit\)/);
  assert.match(a.message, /sparelimit reset/);
});

test("no nudge while the cache is still warm, for small conversations, or when the saving is trivial", () => {
  assert.equal(coldCacheAdvice({ now: NOW, tail: tailOf(req("1h"), asst(30, 400_000)) }), null, "30 min < 1 h lifetime");
  assert.equal(coldCacheAdvice({ now: NOW, tail: tailOf(req("1h"), asst(120, 30_000)) }), null, "under 50k tokens");
  assert.equal(coldCacheAdvice({ now: NOW, tail: tailOf(req("1h"), asst(120, 60_000)) }), null, "extra cost under $0.50");
  assert.equal(coldCacheAdvice({ now: NOW, tail: "" }), null);
});

test("a 5-minute cache goes cold after 5 minutes, and the cost uses the 5-minute write price", () => {
  const tail = (min) => tailOf(req("5m"), asst(min, 300_000, { ttl1h: 0 }));
  assert.equal(coldCacheAdvice({ now: NOW, tail: tail(3) }), null);
  const a = coldCacheAdvice({ now: NOW, tail: tail(8) });
  assert.equal(a.evidence.ttl, "5m");
  assert.equal(a.evidence.resumeUSD, 0.75); // 300k x $2.50
});

test("subagent and synthetic responses do not count as the conversation's last turn; a partial first line in a tail is ignored", () => {
  const synthetic = JSON.stringify({ type: "assistant", timestamp: iso(1), message: { model: "<synthetic>", usage: { input_tokens: 1 } } });
  const tail = tailOf(asst(120, 400_000), asst(1, 900_000, { side: true }), synthetic);
  assert.equal(lastTurn(tail).ctx, 400_000);
  const file = path.join(os.tmpdir(), `sparelimit-tail-${process.pid}.jsonl`);
  fs.writeFileSync(file, "x".repeat(5000) + "\n" + tail);
  assert.equal(lastTurn(readTail(file, 1500)).ctx, 400_000);
  fs.unlinkSync(file);
});

// ---- through the hook
function transcript(ago) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-coach-")), "t.jsonl");
  fs.writeFileSync(f, tailOf(req("1h"), asst(200, 60_000), asst(ago, 400_000)));
  return f;
}
const prompt = (f, o = {}) => handleHook("userpromptsubmit", { session_id: "s1", transcript_path: f }, { now: NOW, refresh: false, ...o });

test("hook: the nudge reaches the user (systemMessage), is logged, and is not repeated within 10 minutes", () => {
  tempSparelimitHome();
  const f = transcript(90);
  const out = JSON.parse(prompt(f).stdout);
  assert.match(out.systemMessage, /^\[sparelimit\] Your conversation/);
  assert.equal(out.hookSpecificOutput, undefined, "the model is not asked to relay by default: the in-app line works");
  assert.equal(prompt(f).stdout, "", "not repeated");
  const rows = fs.readFileSync(auditPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.find((r) => r.kind === "coach").evidence.resumeUSD, 1.6);
});

test("hook: coach settings are respected (off, or user-only delivery) and a warm cache says nothing", () => {
  tempSparelimitHome();
  writeJsonAtomic(configPath(), { coach: { enabled: false } });
  assert.equal(prompt(transcript(90)).stdout, "");
  writeJsonAtomic(configPath(), { coach: { deliver: "user" } });
  const out = JSON.parse(prompt(transcript(90), { now: NOW + 1 }).stdout);
  assert.ok(out.systemMessage);
  assert.equal(out.hookSpecificOutput, undefined, "the model is not told when delivery is user-only");
  tempSparelimitHome();
  assert.equal(prompt(transcript(20)).stdout, "");
});

test("hook: quota warnings are shown to the user (systemMessage); asking the model to relay them is opt-in", () => {
  tempSparelimitHome();
  writeJsonAtomic(snapshotPath("s1"), { sessionId: "s1", receivedAtMs: NOW - 1000, contextPct: 65 });
  const out = JSON.parse(handleHook("userpromptsubmit", { session_id: "s1" }, { now: NOW, refresh: false }).stdout);
  assert.match(out.systemMessage, /Context window is 65% full/);
  assert.equal(out.hookSpecificOutput, undefined, "no model relay by default: the in-app line works");
  writeJsonAtomic(configPath(), { delivery: { relay: true } });
  writeJsonAtomic(snapshotPath("s3"), { sessionId: "s3", receivedAtMs: NOW - 1000, contextPct: 65 });
  const r3 = JSON.parse(handleHook("userpromptsubmit", { session_id: "s3" }, { now: NOW, refresh: false }).stdout);
  assert.match(r3.hookSpecificOutput.additionalContext, /Mention this to the user in one short sentence/);
  assert.match(r3.hookSpecificOutput.additionalContext, /Context window is 65% full/);
});

test("regression: a tool-call hook must not use up the warning that only the user-prompt hook can show", () => {
  tempSparelimitHome();
  writeJsonAtomic(snapshotPath("s1"), { sessionId: "s1", receivedAtMs: NOW - 1000, contextPct: 65 });
  const tool = handleHook("pretooluse", { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }, { now: NOW, refresh: false });
  assert.deepEqual(tool, { stdout: "", stderr: "", exit: 0 }, "warn-level findings cannot be displayed by a tool-call hook");
  const out = JSON.parse(handleHook("userpromptsubmit", { session_id: "s1" }, { now: NOW + 5000, refresh: false }).stdout);
  assert.match(out.systemMessage, /Context window is 65% full/);
  assert.equal(handleHook("userpromptsubmit", { session_id: "s1" }, { now: NOW + 9000, refresh: false }).stdout, "", "then not repeated within 10 minutes");
});

test("probe: one line through every channel (user message, model relay, desktop notification), then it disarms itself", () => {
  tempSparelimitHome();
  writeJsonAtomic(probePath(), { id: "ab12" });
  const calls = [];
  const out = JSON.parse(handleHook("userpromptsubmit", { session_id: "s1" }, { now: NOW, refresh: false, notifyFn: (...a) => calls.push(a) }).stdout);
  assert.match(out.systemMessage, /\(probe ab12\)/);
  assert.match(out.hookSpecificOutput.additionalContext, /sparelimit probe ab12 received/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "Sparelimit");
  assert.equal(fs.existsSync(probePath()), false);
  const rows = fs.readFileSync(auditPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows.find((r) => r.kind === "probe").channels.sort(), ["desktop", "hookSpecificOutput", "systemMessage"]);
  assert.equal(handleHook("userpromptsubmit", { session_id: "s1" }, { now: NOW + 1000, refresh: false, notifyFn: () => assert.fail("no second probe") }).stdout, "");
});

test("delivery channels can be switched off individually, and desktop notifications are opt-in", () => {
  tempSparelimitHome();
  writeJsonAtomic(snapshotPath("s1"), { sessionId: "s1", receivedAtMs: NOW - 1000, contextPct: 65 });
  const notified = [];
  handleHook("userpromptsubmit", { session_id: "s1" }, { now: NOW, refresh: false, notifyFn: (...a) => notified.push(a) });
  assert.equal(notified.length, 0, "off by default");
  tempSparelimitHome();
  writeJsonAtomic(snapshotPath("s1"), { sessionId: "s1", receivedAtMs: NOW - 1000, contextPct: 65 });
  writeJsonAtomic(configPath(), { delivery: { desktop: true } });
  handleHook("userpromptsubmit", { session_id: "s1" }, { now: NOW, refresh: false, notifyFn: (...a) => notified.push(a) });
  assert.equal(notified.length, 1);
  tempSparelimitHome();
  writeJsonAtomic(snapshotPath("s1"), { sessionId: "s1", receivedAtMs: NOW - 1000, contextPct: 65 });
  writeJsonAtomic(configPath(), { delivery: { systemMessage: false } });
  assert.deepEqual(JSON.parse(handleHook("userpromptsubmit", { session_id: "s1" }, { now: NOW, refresh: false }).stdout), {});
});
