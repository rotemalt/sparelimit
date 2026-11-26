import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { metricsFor, judge, buildAdoption, setMarker, clearMarker, readMarkers, HABITS } from "../src/adoption.mjs";
import { buildDigest } from "../src/digest.mjs";
import { ROOT, fixture, tempSparelimitHome } from "./helpers.mjs";

const sparelimitHome = tempSparelimitHome();
const NOW = Date.parse("2026-11-05T00:00:00Z"); // midnight, so a declared start date (a day) lines up with the periods
const DAY = 86400e3;
const ev = (daysAgo, o = {}) => ({ t: NOW - daysAgo * DAY, cost: 1, side: false, pct: 20, exp: false, type: "edit", coldUSD: 0, ...o });
// n responses spread evenly over the days (from, to] ago
const spread = (fromAgo, toAgo, n, f = () => ({})) => Array.from({ length: n }, (_, i) => ev(fromAgo - ((fromAgo - toAgo) * (i + 0.5)) / n, f(i)));
const result = (timeline, start = NOW - 30 * DAY, startTokens = 80_000) => ({ start: new Date(start).toISOString(), timeline, spendBreakdown: { startContextTokens: startTokens } });

test("metrics are rates: context share, cold returns per 100, expensive share of low-risk work, subagent share, outcome cost per 100", () => {
  const tl = [
    ...Array.from({ length: 80 }, (_, i) => ev(5, { pct: i < 20 ? 70 : 30, cost: 1, coldUSD: i < 4 ? 2 : 0 })), // 80 main responses: 20 high, 4 cold
    ev(5, { side: true, cost: 20, type: "run", exp: true }), // subagent work on an expensive model
    ev(5, { type: "run", exp: true, cost: 10 }), ev(5, { type: "explore", exp: false, cost: 10 }),
    ev(30, { pct: 99 }) // outside the period
  ];
  const m = metricsFor(tl, [], NOW - 10 * DAY, NOW);
  assert.equal(m.responses, 82);
  assert.equal(m.ctxHighShare, 24.4); // 20 of 82
  assert.equal(m.coldPer100, 4.88);
  assert.equal(m.coldUSD, 8);
  assert.equal(m.expLowShare, 75); // low-risk spend: 20 + 10 on Opus, 10 on Sonnet-class
  assert.equal(m.sideShare, 16.7); // 20 of the 120 spent
  assert.equal(m.costPer100, 146.3); // 120 spent / 82 main responses x 100
});

test("starting context: the median of sessions that started in the period, only when there are at least three", () => {
  const s = (d, t) => ({ start: NOW - d * DAY, startTokens: t });
  assert.equal(metricsFor([], [s(1, 90_000), s(2, 70_000), s(3, 80_000), s(40, 10_000)], NOW - 10 * DAY, NOW).startMedian, 80_000);
  assert.equal(metricsFor([], [s(1, 90_000), s(2, 70_000)], NOW - 10 * DAY, NOW).startMedian, null);
});

test("verdicts: improved or worse needs a 25% change that is also big enough in absolute terms; thin data says so", () => {
  const m = (metric, v, responses = 100) => ({ responses, [metric]: v });
  assert.equal(judge("reset-early", m("ctxHighShare", 40), m("ctxHighShare", 20)).verdict, "improved");
  assert.equal(judge("reset-early", m("ctxHighShare", 20), m("ctxHighShare", 40)).verdict, "worse");
  assert.equal(judge("reset-early", m("ctxHighShare", 40), m("ctxHighShare", 35)).verdict, "no clear change", "-12%");
  assert.equal(judge("reset-early", m("ctxHighShare", 4), m("ctxHighShare", 2.5)).verdict, "no clear change", "-37% but under 2 points");
  assert.equal(judge("no-cold-resume", m("coldPer100", 0), m("coldPer100", 0)).verdict, "no clear change");
  assert.equal(judge("no-cold-resume", m("coldPer100", 0), m("coldPer100", 3)).verdict, "worse", "from zero");
  assert.equal(judge("reset-early", m("ctxHighShare", 40, 49), m("ctxHighShare", 20)).verdict, "not enough data");
  assert.equal(judge("model-low-risk", m("expLowShare", null), m("expLowShare", 10)).verdict, "not enough data");
  assert.match(judge("reset-early", m("ctxHighShare", 40, 49), m("ctxHighShare", 20)).reason, /49 responses before and 100 after/);
});

test("with a declared start date: the period after it against an equally long one before; the outcome cost is reported beside it", () => {
  const tl = [...spread(28, 14, 100, (i) => ({ pct: i < 40 ? 70 : 20, cost: 2 })), ...spread(14, 0, 100, (i) => ({ pct: i < 10 ? 70 : 20, cost: 1 }))];
  const a = buildAdoption({ results: [result(tl)], markers: { "reset-early": { date: "2026-10-22" } }, now: NOW });
  const h = a.habits.find((x) => x.id === "reset-early");
  assert.deepEqual(h.start, { date: "2026-10-22", source: "declared" });
  assert.equal(h.before.ctxHighShare, 40);
  assert.equal(h.after.ctxHighShare, 10);
  assert.equal(h.verdict, "improved");
  assert.equal(h.changePct, -75);
  assert.deepEqual(h.costPer100, { before: 200, after: 100, changePct: -50 });
  assert.equal(h.weekly.length, 6);
  assert.deepEqual([h.weekly[4].value, h.weekly[5].value], [20, 0], "the high-context responses were all in the older half of the period");
});

test("start dates: too early under 7 days; the first coach nudge is used when none is declared; a declared date wins; none = last 14 days against the 14 before", () => {
  const tl = [...spread(28, 14, 100), ...spread(14, 0, 100)];
  const rows = [{ kind: "coach", rule: "cache.cold", t: new Date(NOW - 3 * DAY).toISOString() }, { kind: "coach", rule: "cache.cold", t: new Date(NOW - 1 * DAY).toISOString() }, { kind: "finding", rule: "context.reset", t: new Date(NOW - 20 * DAY).toISOString() }];
  const a = buildAdoption({ results: [result(tl)], auditRows: rows, now: NOW });
  const cold = a.habits.find((x) => x.id === "no-cold-resume");
  assert.deepEqual(cold.start, { date: "2026-11-02", source: "first nudge" });
  assert.equal(cold.verdict, "too early");
  const none = a.habits.find((x) => x.id === "reset-early");
  assert.equal(none.start, null, "a finding is not a coach nudge");
  assert.match(none.periodNote, /last 14 days against the 14 before/);
  const decl = buildAdoption({ results: [result(tl)], markers: { "no-cold-resume": { date: "2026-10-20" } }, auditRows: rows, now: NOW }).habits.find((x) => x.id === "no-cold-resume");
  assert.deepEqual(decl.start, { date: "2026-10-20", source: "declared" });
  assert.notEqual(decl.verdict, "too early");
});

test("markers are saved and cleared on disk", () => {
  setMarker("subagents", Date.parse("2026-11-01T10:00:00Z"));
  assert.equal(readMarkers().subagents.date, "2026-11-01");
  clearMarker("subagents");
  assert.deepEqual(readMarkers(), {});
});

test("digest: only habits with a start date are listed", () => {
  const tl = [...spread(28, 14, 100), ...spread(14, 0, 100)];
  const adoption = buildAdoption({ results: [result(tl)], markers: { subagents: { date: "2026-10-22" } }, now: NOW });
  const d = buildDigest({ events: [], results: [], now: NOW, adoption });
  assert.deepEqual(d.adoption.map((h) => h.id), ["subagents"]);
  assert.equal(buildDigest({ events: [], results: [], now: NOW }).adoption.length, 0);
});

// ---- commands
const home = () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-"));
  fs.mkdirSync(path.join(h, ".claude", "projects", "p"), { recursive: true });
  fs.copyFileSync(fixture("claude-code-session.jsonl"), path.join(h, ".claude", "projects", "p", "s.jsonl"));
  return h;
};
const run = (h, args) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { encoding: "utf8", env: { ...process.env, HOME: h, SPARELIMIT_HOME: sparelimitHome } });

test("sparelimit adopt: lists habits, sets and clears a start date, rejects unknown habits and future dates", () => {
  const h = home();
  assert.match(run(h, ["adopt"]).stdout, /reset-early/);
  const set = run(h, ["adopt", "reset-early", "--date=2026-11-01"]);
  assert.match(set.stdout, /start date 2026-11-01/);
  assert.match(run(h, ["adopt"]).stdout, /\[started 2026-11-01\]/);
  assert.equal(run(h, ["adopt", "nope"]).status, 1);
  assert.equal(run(h, ["adopt", "reset-early", "--date=2999-01-01"]).status, 1);
  assert.match(run(h, ["adopt", "reset-early", "--clear"]).stdout, /Cleared/);
  assert.deepEqual(readMarkers(), {});
});

test("sparelimit track: prints every habit with its verdict, supports --json, and says so when there is no history", () => {
  const h = home();
  const t = run(h, ["track"]);
  assert.equal(t.status, 0, t.stderr);
  for (const id of Object.keys(HABITS)) assert.match(t.stdout, new RegExp(id));
  assert.match(t.stdout, /not enough data/);
  assert.equal(JSON.parse(run(h, ["track", "--json"]).stdout).habits.length, 5);
  assert.equal(run(fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-")), ["track"]).status, 1);
});
