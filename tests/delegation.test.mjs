import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTranscript } from "../src/adapters/index.mjs";
import { fanOutReport, verboseSavings } from "../src/delegation.mjs";
import { replaySession, summarize } from "../src/replay.mjs";
import { buildDigest } from "../src/digest.mjs";
import { loadPricing } from "../src/pricing.mjs";
import { ROOT, fixture, tempSparelimitHome } from "./helpers.mjs";

const sparelimitHome = tempSparelimitHome();
const pricing = loadPricing();
const T0 = Date.parse("2026-11-05T10:00:00Z");
const iso = (min) => new Date(T0 + min * 60e3).toISOString();

// ---- adapter: who is each subagent, and how big was the answer it handed back
const line = (o) => JSON.stringify(o);
const usage = { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 50 };
function sessionWithSubagent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-sub-"));
  const main = path.join(dir, "sess1.jsonl");
  fs.writeFileSync(main, [
    line({ type: "assistant", sessionId: "sess1", uuid: "a1", timestamp: iso(0), message: { id: "m1", model: "claude-sonnet-5-5", usage, content: [{ type: "tool_use", id: "toolu_T1", name: "Task", input: { prompt: "go" } }] } }),
    line({ type: "user", sessionId: "sess1", uuid: "u1", timestamp: iso(5), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_T1", content: "x".repeat(3700) }] } })
  ].join("\n") + "\n");
  fs.mkdirSync(path.join(dir, "sess1", "subagents"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sess1", "subagents", "agent-abc.jsonl"), line({ type: "assistant", sessionId: "sess1", uuid: "s1", timestamp: iso(1), message: { id: "sm1", model: "claude-sonnet-5-5", usage: { ...usage, cache_read_input_tokens: 53000 }, content: [] } }) + "\n");
  fs.writeFileSync(path.join(dir, "sess1", "subagents", "agent-abc.meta.json"), JSON.stringify({ agentType: "researcher", toolUseId: "toolu_T1" }));
  return main;
}

test("adapter: subagent events carry their agent id, type and the Task call that started them; the call knows its answer size", () => {
  const s = parseTranscript(sessionWithSubagent());
  const sub = s.events.find((e) => e.isSidechain);
  assert.deepEqual([sub.agentId, sub.agentType, sub.agentToolUseId], ["agent-abc", "researcher", "toolu_T1"]);
  const task = s.events.flatMap((e) => e.calls).find((c) => c.id === "toolu_T1");
  assert.equal(task.resChars, 3700);
  const f = fanOutReport(s.events.map((ev) => ({ ev, cost: 1 })), 3);
  assert.equal(f.agents, 1);
  assert.equal(f.details[0].answerTokens, 1000); // 3700 characters / 3.7
  assert.equal(f.details[0].startContextTokens, 53010);
  assert.equal(f.verdict, "ok");
});

// ---- verdicts
const agentEvents = (n, { concurrent = true, cost = 1 } = {}) =>
  Array.from({ length: n }, (_, i) => ({ ev: { ts: iso(concurrent ? 0 : i * 10), agentId: `a${i}`, agentType: "coder", model: "m", context: 50_000, calls: [], agentToolUseId: `t${i}` }, cost }));

test("fan-out verdict: swarm needs many agents at once or in total AND a material share of the session; heavy is a big share without a swarm", () => {
  assert.equal(fanOutReport(agentEvents(4), 20).verdict, "swarm"); // 4 at once, 20% of the session
  assert.equal(fanOutReport(agentEvents(4), 20).peakConcurrent, 4);
  assert.equal(fanOutReport(agentEvents(4), 400).verdict, "ok", "4 at once but only 1% of the session");
  assert.equal(fanOutReport(agentEvents(8, { concurrent: false }), 40).verdict, "swarm", "8 in total, one after another, 20% of the session");
  assert.equal(fanOutReport(agentEvents(8, { concurrent: false }), 40).peakConcurrent, 1);
  assert.equal(fanOutReport(agentEvents(2, { cost: 5 }), 20).verdict, "heavy", "two agents, half the bill");
  assert.equal(fanOutReport(agentEvents(2), 100).verdict, "ok");
  assert.equal(fanOutReport([], 10).verdict, "none");
});

test("delegating verbose outputs: saving is the carrying cost less a short answer less one subagent, and never negative", () => {
  const v = [{ tokens: 10_000, carryUSD: 2 }, { tokens: 20_000, carryUSD: 4 }];
  // kept in their place: 2 x 1000/10000 + 4 x 1000/20000 = 0.4; one subagent costs 1.35
  assert.deepEqual(verboseSavings(v, 1.35), { outputs: 2, carryUSD: 6, netSavingUSD: 4.25 });
  assert.equal(verboseSavings([{ tokens: 6_000, carryUSD: 0.5 }], 1.35).netSavingUSD, 0, "a small output does not pay for a subagent");
  assert.deepEqual(verboseSavings([], 1), { outputs: 0, carryUSD: 0, netSavingUSD: 0 });
});

test("replay and summary report delegation: a verbose tool result is found, and the median subagent cost is measured", () => {
  const ev = (min, extra = {}) => ({ id: `e${min}`, ts: iso(min), model: "claude-sonnet-5-5", isSidechain: false, usage: { input: 10, cacheRead: 40_000, cacheWrite5m: 0, cacheWrite1h: 0, output: 100 }, context: 40_010, tools: [], calls: [], confidence: "derived", ...extra });
  const big = { id: "c1", name: "Bash", sig: "Bash:1", res: "abc", resChars: 100_000 }; // ~27k tokens
  const events = [ev(0, { calls: [big] }), ...Array.from({ length: 40 }, (_, i) => ev(i + 1)), ev(50, { isSidechain: true, agentId: "a1", agentType: "coder", agentToolUseId: "c9" })];
  const r = replaySession({ agent: "claude-code", sessionId: "s", events, userTurns: [], commandResults: [], fileTouches: [], raw: {} }, { pricing, withEvents: true });
  assert.equal(r.delegation.verbose.length, 1);
  assert.equal(r.delegation.verbose[0].tool, "Bash");
  assert.ok(r.delegation.verbose[0].carryUSD > 0);
  assert.equal(r.timeline.length, events.length);
  const s = summarize([r]);
  assert.equal(s.delegation.agents, 1);
  assert.equal(s.delegation.verboseOutputs, 1);
  assert.ok(s.delegation.medianAgentCostUSD > 0);
});

// ---- digest
test("digest: spend this week against the week before from per-response times, nudges counted, one focus habit", () => {
  const NOW = Date.parse("2026-11-05T12:00:00Z");
  const d = (ago) => NOW - ago * 86400e3;
  const events = [{ t: d(1), cost: 30 }, { t: d(2), cost: 10 }, { t: d(8), cost: 20 }, { t: d(20), cost: 99 }];
  const summaryResult = { sessionId: "s1", end: new Date(d(1)).toISOString(), start: new Date(d(3)).toISOString(), totalCostUSD: 40, delegation: { verdict: "swarm", agents: 9, peakConcurrent: 4, sideUSD: 12, details: [], verbose: [] }, spendBreakdown: { startContextUSD: 4, cacheReadUSD: 0, cacheWriteUSD: 0, outputUSD: 0, inputUSD: 0 }, toolOutputCarryUSD: {}, reads: { total: 0, identicalRepeats: 0, identicalRepeatsCarryUSD: 0 }, earlierReset: { savingUSD: 5, savingLowUSD: 4, savingHighUSD: 6, actualModelUSD: 1 }, breaks: { messages: 2, over60min: 1, resumeUSD: 3, savingUSD: 2, extraVsWarmUSD: 2.5 }, models: { tasks: {}, errors: {} }, sidechainUSD: 12, byModelUSD: { opus: 0, sonnet: 0, haiku: 0, other: 0 }, opusHalfToSonnetUSD: 0, findings: [], exposure: { afterFirstWarnUSD: 0, afterFirstStopUSD: 0 }, avoidable: { repeatedCallsUSD: 0, oversizedContextUSD: 0 }, start0: 0 };
  const audit = [{ t: new Date(d(1)).toISOString(), kind: "coach", rule: "cache.cold" }, { t: new Date(d(1)).toISOString(), kind: "coach", rule: "cache.cold" }, { t: new Date(d(9)).toISOString(), kind: "coach", rule: "context.reset" }, { t: new Date(d(1)).toISOString(), kind: "finding", rule: "x" }];
  const out = buildDigest({ events, results: [summaryResult, { ...summaryResult, sessionId: "old", end: new Date(d(10)).toISOString() }], auditRows: audit, now: NOW, weeklyLimitUSD: 80 });
  assert.equal(out.spend.thisWeekUSD, 40);
  assert.equal(out.spend.lastWeekUSD, 20);
  assert.equal(out.spend.changePct, 100);
  assert.equal(out.spend.weeklyLimitPct, 50);
  assert.deepEqual(out.spend.busiestDay, { date: "2026-11-04", usd: 30 });
  assert.equal(out.sessionsEnded, 1, "only the session that ended this week");
  assert.deepEqual(out.nudges, { "cache.cold": 2 }, "only coach rows from the last 7 days");
  assert.equal(out.swarms.length, 1);
  assert.equal(out.focus.id, "reset-early");
  assert.equal(out.breaks.times, 2);
});

// ---- commands
const homeWith = (n) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-"));
  if (n) {
    fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
    fs.copyFileSync(fixture("claude-code-session.jsonl"), path.join(home, ".claude", "projects", "p", "s.jsonl"));
  }
  return home;
};
const run = (home, args) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { encoding: "utf8", env: { ...process.env, HOME: home, SPARELIMIT_HOME: sparelimitHome } });

test("sparelimit delegate and sparelimit digest: print their reports, support --json, and say so when there is no history", () => {
  const home = homeWith(1);
  const d = run(home, ["delegate"]);
  assert.equal(d.status, 0, d.stderr);
  assert.match(d.stdout, /SPARELIMIT DELEGATION/);
  assert.match(d.stdout, /No subagents found in 1 sessions/);
  assert.equal(JSON.parse(run(home, ["delegate", "--json"]).stdout).summary.agents, 0);
  const w = run(home, ["digest"]);
  assert.equal(w.status, 0, w.stderr);
  assert.match(w.stdout, /SPARELIMIT WEEKLY DIGEST/);
  assert.ok(JSON.parse(run(home, ["digest", "--json"]).stdout).spend);
  for (const c of ["delegate", "digest"]) assert.equal(run(homeWith(0), [c]).status, 1);
});
