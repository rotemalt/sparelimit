import test from "node:test";
import assert from "node:assert/strict";
import { buildWhy, WHY } from "../src/why.mjs";

const base = () => ({
  sessionId: "s1",
  totalCostUSD: 100,
  earlierReset: { savingUSD: 14, savingLowUSD: 10, savingHighUSD: 18 },
  breaks: { over60min: 3, extraVsWarmUSD: 9 },
  avoidable: { repeatedCallsUSD: 0 },
  reads: { total: 50, identicalRepeats: 10, identicalRepeatsCarryUSD: 4 },
  delegation: { agents: 5, peakConcurrent: 4, sideUSD: 20, lightAgents: 2, lightUSD: 1, verdict: "swarm", verbose: [{ tokens: 12000, carryUSD: 2 }, { tokens: 20000, carryUSD: 3 }] },
  spendBreakdown: { startContextUSD: 11, startContextTokens: 88000 }
});

test("causes are ranked by dollars, each with its share of the session and its label; none is summed", () => {
  const w = buildWhy(base());
  assert.deepEqual(w.causes.map((c) => [c.id, c.usd, c.sharePct, c.kind, c.confidence]), [
    ["subagents", 20, 20, "at stake", "derived"],
    ["context.oversized", 14, 14, "avoidable", "estimated"],
    ["context.start", 11, 11, "at stake", "derived"],
    ["cache.cold", 9, 9, "at stake", "derived"],
    ["tool.output", 5, 5, "at stake", "estimated"],
    ["reads.repeat", 4, 4, "at stake", "estimated"]
  ]);
  assert.equal(w.totalUSD, 100);
  assert.equal(w.total, undefined, "overlapping causes have no total");
  assert.match(w.causes[0].detail, /A swarm\./);
  assert.match(w.causes[1].detail, /range \$10\.00 to \$18\.00/);
});

test("small causes, causes with nothing in them, and sessions without data are left out", () => {
  const r = base();
  r.earlierReset = null;
  r.breaks = { over60min: 0, extraVsWarmUSD: 0 };
  r.delegation = { agents: 0, verbose: [] };
  r.reads = { total: 50, identicalRepeats: 1, identicalRepeatsCarryUSD: 0.5 }; // 0.5% of the session
  r.spendBreakdown.startContextUSD = 11;
  assert.deepEqual(buildWhy(r).causes.map((c) => c.id), ["context.start"]);
  assert.equal(WHY.minSharePct, 1);
  assert.deepEqual(buildWhy({ sessionId: "x", totalCostUSD: 0 }).causes, []);
  assert.deepEqual(buildWhy({ sessionId: "x", totalCostUSD: 5 }).causes, [], "a result with none of the replay's sections");
});

test("repeated calls come from the loop rules, derived", () => {
  const r = base();
  r.avoidable.repeatedCallsUSD = 30;
  const top = buildWhy(r).causes[0];
  assert.deepEqual([top.id, top.kind, top.confidence], ["loop.repeat", "avoidable", "derived"]);
});
