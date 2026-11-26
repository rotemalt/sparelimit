import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetAdvice, coldCacheAdvice } from "../src/coach.mjs";
import { handleHook } from "../src/hook.mjs";
import { auditPath, configPath, snapshotPath, writeJsonAtomic } from "../src/state.mjs";
import { buildHabitCard } from "../src/habits.mjs";
import { tempSparelimitHome } from "./helpers.mjs";

const NOW = Date.parse("2026-11-05T15:00:00Z");
const iso = (agoMin) => new Date(NOW - agoMin * 60e3).toISOString();
const asst = (agoMin, ctx, model = "claude-opus-5-5") =>
  JSON.stringify({ type: "assistant", sessionId: "s", timestamp: iso(agoMin), message: { id: `m${agoMin}-${ctx}`, model, usage: { input_tokens: 5, cache_read_input_tokens: ctx - 1005, cache_creation_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 }, output_tokens: 100 } } });
const req = JSON.stringify({ type: "api-request", sessionId: "s", cacheControl: [{ path: ["system", 1], value: { type: "ephemeral", ttl: "1h" } }] });
// a climbing conversation: starts at 60k, grows `step` tokens a message, last message `ago` minutes ago
const climb = (to, ago = 1, model, step = 2_000) => {
  const lines = [req];
  const n = Math.floor((to - 60_000) / step);
  for (let i = 0; i <= n; i++) lines.push(asst(ago + (n - i) * 0.5, 60_000 + i * step, model));
  return lines.join("\n") + "\n";
};

test("reset coach: at 70% of the window it says what starting fresh now saves until auto-compaction, in dollars and limit share", () => {
  const a = resetAdvice({ now: NOW, tail: climb(140_000), calibration: { points: [{ fivePct: 50, spendFive: 14.5 }] } });
  assert.equal(a.rule, "context.reset");
  assert.equal(a.level, 1);
  // Opus 5.5 cache read $0.20 per M; fresh start = 60k smallest context + 4k handoff + 25k re-read = 89k; saving per message = (140k - 89k) x $0.20/M
  assert.equal(a.evidence.savedPerMessageUSD, 0.0102);
  assert.equal(a.evidence.growthPerMessage, 2_000);
  assert.equal(a.evidence.messagesLeft, 25); // (95% of 200k - 140k) / 2k
  assert.equal(a.evidence.savingUSD, 0.26);
  assert.equal(a.evidence.confidence, "estimated");
  assert.match(a.message, /70% of the window/);
  assert.match(a.message, /about \$0\.26 over the next ~25 messages \(about <1% of your 5-hour limit\) \[estimated\]/);
  assert.match(a.message, /sparelimit reset/);
});

test("reset coach: second level at 80%, silent below 60%, for small savings, for a cold cache, and when disabled", () => {
  assert.equal(resetAdvice({ now: NOW, tail: climb(164_000, 1, undefined, 1_000) }).level, 2);
  assert.equal(resetAdvice({ now: NOW, tail: climb(164_000) }), null, "82% but only 13 messages to auto-compaction: under $0.25 left to gain");
  assert.equal(resetAdvice({ now: NOW, tail: climb(110_000) }), null, "55% of the window");
  assert.equal(resetAdvice({ now: NOW, tail: climb(140_000, 1, "claude-sonnet-5-5") }), null, "Sonnet re-reads are cheap: the saving is under $0.25");
  assert.equal(resetAdvice({ now: NOW, tail: climb(140_000, 120) }), null, "cache already cold: the break advisor speaks instead");
  assert.ok(coldCacheAdvice({ now: NOW, tail: climb(140_000, 120) }));
  assert.equal(resetAdvice({ now: NOW, tail: climb(140_000), config: { enabled: false } }), null);
  assert.equal(resetAdvice({ now: NOW, tail: "" }), null);
});

test("reset coach: a conversation that passed 200k is measured against the 1M window, like the replay", () => {
  const a = resetAdvice({ now: NOW, tail: climb(300_000) });
  assert.equal(a, null, "30% of a 1M window is below the threshold");
});

// ---- through the hook
const file = (tail) => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-reset-")), "t.jsonl");
  fs.writeFileSync(f, tail);
  return f;
};
const prompt = (f, now = NOW, id = "r1") => handleHook("userpromptsubmit", { session_id: id, transcript_path: f }, { now, refresh: false });

test("hook: reset advice reaches the user once per level, again after an hour, and re-arms after the conversation shrinks", () => {
  tempSparelimitHome();
  const big = file(climb(140_000));
  const out = JSON.parse(prompt(big).stdout);
  assert.match(out.systemMessage, /^\[sparelimit\] Your conversation is ~140k tokens/);
  assert.equal(prompt(big, NOW + 11 * 60e3).stdout, "", "same level: not repeated");
  const bigger = file(climb(164_000, 1, undefined, 1_000));
  assert.match(JSON.parse(prompt(bigger, NOW + 22 * 60e3).stdout).systemMessage, /82% of the window/, "next level speaks");
  assert.match(JSON.parse(prompt(file(climb(164_000, 1 - 100, undefined, 1_000)), NOW + 100 * 60e3).stdout).systemMessage, /82%/, "still large after an hour: reminded");
  assert.equal(prompt(file(climb(80_000, 1 - 120)), NOW + 120 * 60e3).stdout, "");
  assert.match(JSON.parse(prompt(file(climb(140_000, 1 - 140)), NOW + 140 * 60e3).stdout).systemMessage, /70%/, "after a reset the first level speaks again");
  const rows = fs.readFileSync(auditPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(rows.filter((r) => r.kind === "coach" && r.rule === "context.reset").length >= 4);
});

test("hook: no double message when the status line already warns that the context is full, and the cold-cache advice wins", () => {
  tempSparelimitHome();
  writeJsonAtomic(snapshotPath("r2"), { sessionId: "r2", receivedAtMs: NOW - 1000, contextPct: 70 });
  const msg = JSON.parse(prompt(file(climb(140_000)), NOW, "r2").stdout).systemMessage;
  assert.match(msg, /Context window is 70% full/);
  assert.doesNotMatch(msg, /Claude Code only compacts near 95%/);
  tempSparelimitHome();
  const cold = JSON.parse(prompt(file(climb(140_000, 120)), NOW, "r3").stdout).systemMessage;
  assert.match(cold, /went cold/);
  assert.doesNotMatch(cold, /Claude Code only compacts/);
  tempSparelimitHome();
  writeJsonAtomic(configPath(), { coach: { enabled: false } });
  assert.equal(prompt(file(climb(140_000)), NOW, "r4").stdout, "");
});

// ---- the "what to change" card
const summary = {
  sessions: 10,
  totalCostUSD: 1000,
  firstStart: "2026-10-01T00:00:00Z",
  lastEnd: "2026-10-29T00:00:00Z", // 4 weeks
  earlierReset: { sessionsModelled: 6, netSavingUSD: 140, netSavingLowUSD: 120, netSavingHighUSD: 160 },
  breaks: { messages: 12, over60min: 9, savingUSD: 120 },
  opusHalfToSonnetUSD: 200,
  byModelUSD: { opus: 600, sonnet: 300, haiku: 0, other: 100 },
  sidechainUSD: 110,
  spendBreakdownUSD: { startContextUSD: 90 },
  toolOutputCarryUSD: { "Command output": 60, Read: 30 },
  reworkUSD: { rewriteLoopUSD: 0, failingRepeatUSD: 0 }
};

test("what-to-change card: savings and spend-at-stake are separate lists, each ranked by dollars, with share of spend and of a weekly limit", () => {
  const c = buildHabitCard(summary, { weeklyLimitUSD: 250 });
  assert.deepEqual(c.savings.map((h) => h.id), ["model-mix", "reset-early", "no-cold-resume"]);
  assert.deepEqual(c.atStake.map((h) => h.id), ["subagents", "start-context", "command-output", "file-reads", "rewrite-loops", "failing-repeats"], "file reads carry 30 here; the two rework rows are 0 without a replay of the calls");
  assert.ok(c.savings.every((h) => h.kind === "saving" && h.confidence === "estimated"));
  assert.ok(c.atStake.every((h) => h.kind === "at-stake"));
  const reset = c.savings.find((h) => h.id === "reset-early");
  assert.equal(reset.shareOfSpend, 14);
  assert.equal(c.weeks, 4);
  assert.equal(reset.weeklyLimitPct, 14); // $140 / 4 weeks = $35 a week = 14% of $250
  assert.deepEqual(reset.range, [120, 160]);
  assert.match(c.note, /not additive/);
});

test("what-to-change card: without a calibrated limit the limit share is left out, not guessed", () => {
  const c = buildHabitCard(summary, { weeklyLimitUSD: null });
  assert.ok([...c.savings, ...c.atStake].every((h) => h.weeklyLimitPct === null));
});
