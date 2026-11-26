import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const vh = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-ca-"));
process.env.SPARELIMIT_HOME = vh;
const { writeClientBudgets, clientBudgetLine, overallBudgetLine, scheduleClientBudgets } = await import("../src/clientalert.mjs");

const now = Date.parse("2026-11-06T12:00:00Z");
const rules = [{ path: "/work/Acme", label: "Acme" }];
const row = (key, period, spentUSD, limitUSD) => ({ key, period, spentUSD, limitUSD, pct: Math.round((spentUSD / limitUSD) * 100), over: spentUSD > limitUSD });
const check = { clients: [{ label: "Acme", rows: [row("dailyUSD", "today", 9, 10), row("weeklyUSD", "this week", 20, 100)], over: [] }] };

test("a session in a client's folder hears once when a period nears its limit; other folders and quiet periods say nothing", () => {
  writeClientBudgets(check, now - 5 * 60e3);
  const shown = {};
  const line = clientBudgetLine({ cwd: "/work/Acme/site", rules, shown, now });
  assert.match(line, /Acme: today \$9 of \$10 \(90%\)/);
  assert.doesNotMatch(line, /this week/);
  assert.match(line, /5 min ago/);
  assert.equal(clientBudgetLine({ cwd: "/work/Acme/site", rules, shown, now }), null, "said once");
  assert.equal(clientBudgetLine({ cwd: "/work/Other", rules, shown: {}, now }), null);
});

test("going over is said again after nearing, and totals older than two hours are not used", () => {
  const shown = {};
  writeClientBudgets(check, now - 60e3);
  clientBudgetLine({ cwd: "/work/Acme", rules, shown, now });
  writeClientBudgets({ clients: [{ label: "Acme", rows: [row("dailyUSD", "today", 11, 10)], over: ["today"] }] }, now - 60e3);
  assert.match(clientBudgetLine({ cwd: "/work/Acme", rules, shown, now }), /today \$11 of \$10 \(110%\)/);
  writeClientBudgets({ clients: [{ label: "Acme", rows: [row("dailyUSD", "today", 11, 10)], over: ["today"] }] }, now - 3 * 3600e3);
  assert.equal(clientBudgetLine({ cwd: "/work/Acme", rules, shown: {}, now }), null);
});

test("a refresh starts only when the saved totals are older than 15 minutes", () => {
  const spawned = [];
  const spawnFn = (...a) => spawned.push(a);
  writeClientBudgets(check, now - 60e3);
  assert.equal(scheduleClientBudgets({ now, spawnFn }), false);
  writeClientBudgets(check, now - 20 * 60e3);
  assert.equal(scheduleClientBudgets({ now, spawnFn }), true);
  assert.equal(scheduleClientBudgets({ now, spawnFn }), false, "locked while the first one runs");
  assert.equal(spawned.length, 1);
});

test("the machine-wide budgets (sparelimit budget) are said the same way: once per level and period, nothing for a period with no limit", () => {
  const overall = { rows: [{ key: "dailyUSD", label: "today", spentUSD: 45, limitUSD: 50, pct: 90, over: false }, { key: "weeklyUSD", label: "this week", spentUSD: 45, limitUSD: null, pct: null, over: false }, { key: "monthlyUSD", label: "this month", spentUSD: 700, limitUSD: 600, pct: 117, over: true }] };
  writeClientBudgets({ clients: [] }, now - 120e3, overall);
  const shown = {};
  const line = overallBudgetLine({ shown, now });
  assert.match(line, /^Budget: today \$45 of \$50 \(90%\); this month \$700 of \$600 \(117%\)\. .* 2 min ago\.$/);
  assert.equal(overallBudgetLine({ shown, now }), null, "said once");
  writeClientBudgets({ clients: [] }, now - 120e3, null);
  assert.equal(overallBudgetLine({ shown: {}, now }), null, "no machine-wide budget cached");
});
