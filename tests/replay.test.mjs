import test from "node:test";
import assert from "node:assert/strict";
import { replaySession, summarize, modelEarlierReset } from "../src/replay.mjs";
import { callSignature } from "../src/schema.mjs";
import { loadPricing } from "../src/pricing.mjs";
import { tempSparelimitHome } from "./helpers.mjs";

tempSparelimitHome();
const pricing = loadPricing();
const T0 = Date.parse("2026-11-05T10:00:00Z");
const iso = (min) => new Date(T0 + min * 60e3).toISOString();
const cost = (ctx) => (10 * 2 + (ctx - 10) * 0.1 + 100 * 10) / 1e6; // claude-sonnet-5-5: $2 in, $0.10 cache read, $10 out per MTok

function ev(min, ctx, calls = [], side = false) {
  return { id: `e${min}-${ctx}`, ts: iso(min), model: "claude-sonnet-5-5", isSidechain: side, usage: { input: 10, cacheRead: ctx - 10, cacheWrite5m: 0, cacheWrite1h: 0, output: 100 }, context: ctx, tools: [], calls, confidence: "derived" };
}
const stuck = (n) => Array.from({ length: n }, () => ({ name: "Bash", sig: callSignature("Bash", { command: "npm test" }), res: "!abc" }));
const session = (events) => ({ agent: "claude-code", sessionId: "s-test", events, userTurns: [], commandResults: [], fileTouches: [], raw: {} });

test("context warning at 60% and stop at 95% of the window, with active minutes and spend at that moment", () => {
  const events = [ev(0, 50_000), ev(1, 110_000), ev(2, 125_000), ev(3, 150_000), ev(4, 192_000), ev(5, 195_000)];
  const r = replaySession(session(events), { pricing });
  const ctx = r.findings.filter((f) => f.rule === "context.window");
  assert.deepEqual(ctx.map((f) => [f.level, f.minute]), [["warn", 2], ["block", 4]]);
  const spentAtWarn = [50_000, 110_000, 125_000].reduce((n, c) => n + cost(c), 0);
  assert.ok(Math.abs(ctx[0].costSoFarUSD - spentAtWarn) < 0.01);
  assert.equal(r.exposure.afterFirstStopMinutes, 1);
  assert.ok(Math.abs(r.exposure.afterFirstStopUSD - cost(195_000)) < 0.01);
});

test("idle gaps over 10 minutes are not counted as active time", () => {
  const events = [ev(0, 20_000), ev(5, 20_000), ev(300, 20_000), ev(304, 20_000)];
  const r = replaySession(session(events), { pricing });
  assert.equal(r.durationMin, 9); // 5 + 4, the five-hour gap is skipped
  assert.ok(r.spanDays >= 0.2);
});

test("same call with the same result: warn at 4, stop at 8; only the repeats after the stop are the avoidable part", () => {
  const events = Array.from({ length: 12 }, (_, i) => ev(i, 30_000, stuck(1)));
  const r = replaySession(session(events), { pricing });
  const loops = r.findings.filter((f) => f.rule === "loop.no_progress" || f.rule === "loop.identical_calls");
  assert.ok(loops.some((f) => f.level === "warn" && f.minute === 3));
  assert.ok(loops.some((f) => f.level === "block" && f.minute === 7));
  assert.equal(r.avoidable.repeatedCallsConfidence, "derived");
  assert.ok(Math.abs(r.avoidable.repeatedCallsUSD - 4 * cost(30_000)) < 0.01, `avoidable ${r.avoidable.repeatedCallsUSD}`); // events 8..11
});

test("a repeated call whose result changes is NOT flagged as no-progress", () => {
  const events = Array.from({ length: 12 }, (_, i) => ev(i, 30_000, [{ name: "Read", sig: callSignature("Read", { file_path: "/a" }), res: `r${i}` }]));
  const r = replaySession(session(events), { pricing });
  assert.equal(r.findings.filter((f) => f.rule === "loop.no_progress").length, 0);
});

test("dollar budgets are not replayed by default (arbitrary for long sessions)", () => {
  const r = replaySession(session(Array.from({ length: 5 }, (_, i) => ({ ...ev(i, 20_000), usage: { input: 1_000_000, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 1_000_000 } }))), { pricing });
  assert.equal(r.findings.filter((f) => f.rule.startsWith("budget")).length, 0);
  assert.ok(r.totalCostUSD > 25);
});

test("summary counts sessions and keeps derived and estimated amounts apart", () => {
  const a = replaySession(session([ev(0, 50_000), ev(1, 192_000), ev(2, 195_000)]), { pricing });
  const b = replaySession(session([ev(0, 20_000), ev(1, 21_000)]), { pricing });
  const s = summarize([a, b, null]);
  assert.equal(s.sessions, 2);
  assert.equal(s.sessionsWithStop, 1);
  assert.equal(s.sessionsWithWarning, 1);
  assert.ok(s.byRule["context.window:block"] === 1);
});

test("empty or timestamp-less sessions return null instead of inventing numbers", () => {
  assert.equal(replaySession(session([]), { pricing }), null);
  assert.equal(replaySession(session([{ ...ev(0, 1000), ts: undefined }]), { pricing }), null);
});

const rates = { cacheRead: 0.1, cacheWrite5m: 2.5, output: 10 };
const mainOf = (contexts) => contexts.map((c) => ({ ev: { context: c }, rates }));
const ramp = (from, to, step) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

test("earlier reset model: a long climb to the window saves money, and more re-reading after each reset saves less", () => {
  const contexts = [...ramp(20_000, 195_000, 1_000), 40_000, ...ramp(41_000, 195_000, 1_000)]; // slow climbs (many messages per cycle) with one real auto-compaction
  const none = modelEarlierReset(mainOf(contexts), 200_000, { threshold: 0.6, rebuildTokens: 0 });
  const heavy = modelEarlierReset(mainOf(contexts), 200_000, { threshold: 0.6, rebuildTokens: 60_000 });
  assert.equal(none.realCompactions, 1);
  assert.ok(none.savingUSD > 0, `saving ${none.savingUSD}`);
  assert.ok(heavy.savingUSD < none.savingUSD);
  assert.ok(none.resets >= 2);
});

test("earlier reset model: sessions that never get large are not changed, and short sessions are not modelled", () => {
  const small = modelEarlierReset(mainOf(Array.from({ length: 40 }, (_, i) => 20_000 + i * 100)), 200_000);
  assert.ok(Math.abs(small.savingUSD) < 1e-9);
  assert.equal(modelEarlierReset(mainOf([1, 2, 3]), 200_000), null);
});

test("spend breakdown adds up to the total, and the fixed starting context is the smallest context seen", () => {
  const events = [ev(0, 50_000), ev(1, 60_000), ev(2, 70_000), ev(3, 80_000), ev(4, 90_000)];
  const r = replaySession(session(events), { pricing });
  const b = r.spendBreakdown;
  assert.ok(Math.abs(b.cacheReadUSD + b.cacheWriteUSD + b.outputUSD + b.inputUSD - r.totalCostUSD) < 0.01);
  assert.equal(b.startContextTokens, 50_000);
  assert.ok(Math.abs(b.startContextUSD - (5 * 50_000 * 0.1) / 1e6) < 0.01);
});

test("cost of carrying a tool output: written once, then re-read on every later message until compaction", () => {
  const withOutput = ev(0, 20_000, [{ name: "Bash", sig: callSignature("Bash", { command: "ls" }), res: "okabc", resChars: 3700 }]); // 1,000 tokens
  const r = replaySession(session([withOutput, ev(1, 21_000), ev(2, 22_000), ev(3, 23_000)]), { pricing });
  const expected = (1000 * 2.5 + 3 * 1000 * 0.1) / 1e6;
  assert.ok(Math.abs(r.toolOutputCarryUSD["Command output"] - expected) < 0.01, JSON.stringify(r.toolOutputCarryUSD));
});

test("identical file re-reads are counted separately from re-reads of changed files", () => {
  const read = (res) => [{ name: "Read", sig: callSignature("Read", { file_path: "/a" }), res, resChars: 400 }];
  const r = replaySession(session([ev(0, 20_000, read("r1")), ev(1, 21_000, read("r1")), ev(2, 22_000, read("r2")), ev(3, 23_000, [])]), { pricing });
  assert.equal(r.reads.total, 3);
  assert.equal(r.reads.identicalRepeats, 1);
});

test("who did the work: side-thread spend and spend by model family are derived; half the Opus work on Sonnet is a what-if", () => {
  const opus = { ...ev(0, 50_000), model: "claude-opus-5-5" };
  const opusSide = { ...ev(1, 50_000, [], true), model: "claude-opus-5-5" };
  const sonnet = ev(2, 50_000);
  const r = replaySession(session([opus, opusSide, sonnet]), { pricing });
  const opusCost = (10 * 4 + 49_990 * 0.2 + 100 * 20) / 1e6; // claude-opus-5-5: $4 in, $0.20 cache read, $20 out per MTok
  assert.ok(Math.abs(r.byModelUSD.opus - 2 * opusCost) < 0.01);
  assert.ok(Math.abs(r.byModelUSD.sonnet - cost(50_000)) < 0.01);
  assert.ok(Math.abs(r.sidechainUSD - opusCost) < 0.01);
  assert.ok(Math.abs(r.opusHalfToSonnetUSD - (2 * (opusCost - cost(50_000))) / 2) < 0.01);
  const s = summarize([r, r]);
  assert.ok(Math.abs(s.sidechainUSD - 2 * r.sidechainUSD) < 0.01);
  assert.equal(s.firstStart, r.start);
});
