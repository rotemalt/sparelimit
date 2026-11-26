import test from "node:test";
import assert from "node:assert/strict";
import { buildHistory } from "../src/history.mjs";

const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
const now = at(2026, 11, 7);
const sess = (project, evs, extra = {}) => ({ project: `/home/.claude/projects/${project}`, totalCostUSD: evs.reduce((n, e) => n + e[1], 0), timeline: evs.map(([t, cost]) => ({ t, cost })), ...extra });

test("spend is grouped by local day and by week from Monday, only inside the period, and by project", () => {
  const h = buildHistory([
    sess("-Users-me-alpha", [[at(2026, 11, 7), 5], [at(2026, 11, 6), 3], [at(2026, 11, 2), 2]]), // Fri 6th, Sat 7th, Mon 2nd of the same week
    sess("-Users-me-beta", [[at(2026, 10, 31), 4], [at(2026, 9, 1), 100]]), // the Sept one is outside 30 days
    sess("-Users-me-old", [[at(2026, 8, 1), 50]])
  ], { now, days: 30 });
  assert.equal(h.totalUSD, 14);
  assert.equal(h.sessions, 2);
  assert.deepEqual(h.weekly, [{ weekStart: "2026-10-26", usd: 4 }, { weekStart: "2026-11-02", usd: 10 }]);
  assert.deepEqual(h.daily.map((d) => [d.date, d.usd]), [["2026-10-31", 4], ["2026-11-02", 2], ["2026-11-06", 3], ["2026-11-07", 5]]);
  assert.deepEqual(h.projects.map((p) => [p.project, p.usd, p.sessions]), [["alpha", 10, 1], ["beta", 4, 1]]);
  assert.equal(h.confidence, "derived");
});

test("causes from the why engine are summed per cause across sessions and never across causes", () => {
  const withCause = (usd) => sess("-Users-me-a", [[now - 1000, 100]], { totalCostUSD: 100, rework: { rewriteLoops: [{ file: "x.js", edits: 5, spanResponses: 9, costUSD: usd }], failingRepeats: [], rewriteLoopUSD: usd, failingRepeatUSD: 0 } });
  const h = buildHistory([withCause(10), withCause(6)], { now, days: 7 });
  assert.deepEqual(h.causes.map((c) => [c.id, c.usd, c.sessions]), [["rework.edits", 16, 2]]);
  assert.match(h.note, /overlap/);
});
