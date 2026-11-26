import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, sanitizePolicy, sanitizeBudgets, sanitizeIgnore } from "../src/config.mjs";
import { evaluate, mergePolicy, PRESETS } from "../src/policy.mjs";
import { checkBudgets, periodStarts } from "../src/budget.mjs";
import { ROOT } from "./helpers.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-cfg-"));
const writeJson = (f, o) => (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, JSON.stringify(o)));

test("values are checked: a wrong type is dropped (never read as 'off'), unknown keys and presets are ignored", () => {
  const p = sanitizePolicy({ preset: "nope", context: { warnPct: "50", blockPct: null, bogus: 1 }, quota: { projectionWarn: false, fiveHourWarnPct: 70 }, extra: { a: 1 } });
  assert.deepEqual(p, { context: { blockPct: null }, quota: { projectionWarn: false, fiveHourWarnPct: 70 } });
  assert.equal(sanitizePolicy({ preset: "steady" }).preset, "steady");
  assert.deepEqual(sanitizeBudgets({ dailyUSD: 50, weeklyUSD: -1, monthlyUSD: "9", other: 5 }), { dailyUSD: 50 });
  assert.deepEqual(sanitizeIgnore({ rules: ["loop.identical_calls", 5, "x y", "../../etc"] }), { rules: ["loop.identical_calls"] });
  assert.deepEqual(sanitizePolicy(null), {});
});

test("a project file only tightens: the stricter number wins, and only your own ignored rules count", () => {
  const g = path.join(tmp(), "config.json");
  const proj = tmp();
  writeJson(g, { policy: { context: { warnPct: 70, blockPct: 90 } }, budgets: { dailyUSD: 50, weeklyUSD: 200 }, ignore: { rules: ["a.b"] } });
  writeJson(path.join(proj, ".sparelimit", "config.json"), { policy: { context: { warnPct: 40 } }, budgets: { dailyUSD: 10 }, ignore: { rules: ["c.d"] } });
  const c = loadConfig({ cwd: proj, globalFile: g });
  assert.deepEqual(c.policy.context, { warnPct: 40, blockPct: 90 });
  assert.deepEqual(c.budgets, { dailyUSD: 10, weeklyUSD: 200 });
  assert.deepEqual(c.ignore.rules, ["a.b"]);
  assert.deepEqual(loadConfig({ cwd: tmp(), globalFile: path.join(tmp(), "none.json") }).budgets, {});
});

test("presets are starting points that your own values override", () => {
  assert.equal(mergePolicy({ preset: "agency-day" }).budget.hourlyWarnUSD, 10);
  assert.equal(mergePolicy({ preset: "agency-day", budget: { hourlyWarnUSD: 4 } }).budget.hourlyWarnUSD, 4);
  assert.equal(mergePolicy({ preset: "steady" }).context.warnPct, 50);
  assert.equal(mergePolicy({}).quota.weeklyPaceMarginPts, null, "off by default");
  assert.ok(Object.keys(PRESETS).includes("weekly-pace"));
});

test("weekly pace: warns when the quota is used faster than the week has gone, only after a seventh of the week, only when switched on", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  const week = 7 * 86400e3;
  const at = (daysIn, pct) => ({ snapshot: { rateLimits: { sevenDay: { pct, resetsAt: (now + week - daysIn * 86400e3) / 1000 } } }, now, policy: { preset: "weekly-pace" } });
  const hit = evaluate(at(3, 55)).findings.find((f) => f.rule === "quota.weekly_pace");
  assert.ok(hit, "55% used on day 3 (43% of the week gone) is 12 points ahead");
  assert.equal(hit.level, "warn");
  assert.equal(evaluate(at(3, 48)).findings.some((f) => f.rule === "quota.weekly_pace"), false, "5 points ahead is within the margin");
  assert.equal(evaluate(at(0.5, 40)).findings.some((f) => f.rule === "quota.weekly_pace"), false, "half a day in is less than a seventh of the week");
  assert.equal(evaluate({ ...at(3, 90), policy: {} }).findings.some((f) => f.rule === "quota.weekly_pace"), false, "off without the preset");
});

test("budgets: the local calendar day, the week from Monday, the month from the 1st; over means strictly more than the limit", () => {
  const now = new Date(2026, 10, 4, 15, 0).getTime(); // Wednesday 4 November 2026, local
  const s = periodStarts(now);
  assert.equal(new Date(s.dailyUSD).getDate(), 4);
  assert.equal(new Date(s.weeklyUSD).getDay(), 1, "a Monday");
  assert.equal(new Date(s.weeklyUSD).getDate(), 2);
  assert.equal(new Date(s.monthlyUSD).getDate(), 1);
  const ev = [{ t: new Date(2026, 10, 4, 9).getTime(), cost: 6 }, { t: new Date(2026, 10, 3, 9).getTime(), cost: 5 }, { t: new Date(2026, 9, 31, 9).getTime(), cost: 100 }, { t: now + 1000, cost: 999 }];
  const r = checkBudgets(ev, { dailyUSD: 6, weeklyUSD: 10, monthlyUSD: 1000 }, now);
  assert.deepEqual(r.rows.map((x) => [x.spentUSD, x.over]), [[6, false], [11, true], [11, false]]);
  assert.deepEqual(r.over, ["this week"]);
  assert.equal(checkBudgets(ev, {}, now).anySet, false);
});

test("sparelimit budget --check exits 1 when over, 0 when not set or under, 2 for a bad value; sparelimit policy writes the preset", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-"));
  fs.mkdirSync(path.join(home, ".claude", "projects", "-p"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "projects", "-p", "s.jsonl"), JSON.stringify({ type: "assistant", sessionId: "s", uuid: "a", timestamp: new Date().toISOString(), message: { id: "m", model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 0, output_tokens: 100 }, content: [] } }) + "\n");
  const vh = tmp();
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...a], { encoding: "utf8", env: { ...process.env, HOME: home, SPARELIMIT_HOME: vh } });
  assert.equal(run("budget", "--check").status, 0, "no budget set is not over");
  assert.equal(run("budget", "daily=0.001", "--check").status, 1);
  assert.equal(run("budget", "daily=1000", "--check").status, 0);
  assert.equal(run("budget", "daily=abc").status, 2);
  assert.match(run("policy", "agency-day").stdout, /Preset agency-day/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(vh, "config.json"), "utf8")).policy.preset, "agency-day");
  assert.equal(run("policy", "bogus").status, 2);
});
