import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLedger, interventions } from "../src/ledger.mjs";
import { buildDigest } from "../src/digest.mjs";
import { ROOT, fixture, tempSparelimitHome } from "./helpers.mjs";

const sparelimitHome = tempSparelimitHome();
const MIN = 60e3;
const T0 = Date.parse("2026-11-05T10:00:00Z");
const NOW = T0 + 24 * 3600e3; // a day later: every window is over
const iso = (ms) => new Date(ms).toISOString();
const resp = (t, cost, pct = 30, extra = {}) => ({ t, cost, side: false, pct, exp: false, type: "edit", coldUSD: 0, ...extra });
// n responses one minute apart starting at `from`
const run = (from, n, cost, pct = 30, extra = {}) => Array.from({ length: n }, (_, i) => resp(from + i * MIN, cost, pct, extra));
const session = (id, project, start, timeline) => ({ sessionId: id, project, start: iso(start), timeline });
const audit = (rule, t, sessionId = "s1", kind = rule.startsWith("quota") || rule === "context.window" ? "finding" : "coach", evidence = {}) => ({ t: iso(t), kind, rule, sessionId, evidence });
const ledger = (auditRows, results, now = NOW) => buildLedger({ auditRows, results, now, weeklyLimitUSD: 250 });

// ---- reset
const pre = () => run(T0 - 12 * MIN, 12, 1, 70); // 12 responses at $1, 70% of the window

test("reset: counted when the context shrank (/compact) and the cost per response fell; saving = (before - after) x responses, measured", () => {
  const tl = [...pre(), ...run(T0 + MIN, 3, 1, 70), ...run(T0 + 5 * MIN, 30, 0.4, 30)];
  const l = ledger([audit("context.reset", T0)], [session("s1", "/p", T0 - 3600e3, tl)]);
  const e = l.entries[0];
  assert.equal(e.status, "counted");
  assert.equal(e.savingUSD, 18); // (1.00 - 0.40) x 30
  assert.match(e.how, /\/compact/);
  assert.deepEqual([e.before.responses, e.after.responses], [10, 30]);
  assert.match(e.confidence, /measured before\/after/);
  assert.equal(l.totals.countedUSD, 18);
  assert.equal(l.totals.countedPctOfWeeklyLimit, 7.2);
});

test("reset: counted savings can be negative: the ledger reports it when the cost went up afterwards", () => {
  const tl = [...pre(), ...run(T0 + 5 * MIN, 30, 1.5, 30)];
  const e = ledger([audit("context.reset", T0)], [session("s1", "/p", T0 - 3600e3, tl)]).entries[0];
  assert.equal(e.status, "counted");
  assert.equal(e.savingUSD, -15);
});

test("reset: a new conversation in the same project with a small start counts; one in another project, or with a big start, does not", () => {
  const old = session("s1", "/p", T0 - 3600e3, pre());
  const fresh = (project, pct) => session("s2", project, T0 + 10 * MIN, run(T0 + 10 * MIN, 30, 0.4, pct));
  const ok = ledger([audit("context.reset", T0)], [old, fresh("/p", 15)]).entries[0];
  assert.equal(ok.status, "counted");
  assert.equal(ok.savingUSD, 18);
  assert.match(ok.how, /new conversation/);
  assert.equal(ledger([audit("context.reset", T0)], [old, fresh("/other", 15)]).entries[0].status, "ignored");
  assert.equal(ledger([audit("context.reset", T0)], [old, fresh("/p", 60)]).entries[0].status, "ignored", "a restart that began at 60% is not a reset");
});

test("reset: ignored when the conversation kept growing (with what the nudge predicted), pending inside 3 hours, no data without a before", () => {
  const grow = session("s1", "/p", T0 - 3600e3, [...pre(), ...run(T0 + MIN, 20, 1, 75)]);
  const rows = [audit("context.reset", T0, "s1", "coach", { savingUSD: 7 })];
  const l = ledger(rows, [grow]);
  assert.equal(l.entries[0].status, "ignored");
  assert.equal(l.entries[0].predictedUSD, 7);
  assert.equal(l.totals.ignoredPredictedUSD, 7);
  assert.equal(l.totals.countedUSD, 0);
  assert.equal(ledger(rows, [grow], T0 + 2 * 3600e3).entries[0].status, "pending");
  assert.equal(ledger(rows, [session("s1", "/p", T0, run(T0 - 2 * MIN, 3, 1, 70))]).entries[0].status, "no-data");
  assert.equal(ledger(rows, []).entries[0].status, "no-data");
});

test("a context.window warning from the status line is evaluated like the coach's reset nudge", () => {
  const tl = [...pre(), ...run(T0 + 5 * MIN, 30, 0.4, 30)];
  assert.equal(ledger([audit("context.window", T0)], [session("s1", "/p", T0 - 3600e3, tl)]).entries[0].savingUSD, 18);
});

// ---- cold cache
test("cold cache: counted when no cold return followed and a new conversation started; saving = resume cost - measured cost of its first 3 responses", () => {
  const old = session("s1", "/p", T0 - 7200e3, run(T0 - 4000 * MIN / 60, 5, 1, 60));
  const fresh = session("s2", "/p", T0 + 10 * MIN, run(T0 + 10 * MIN, 5, 0.5, 15));
  const e = ledger([audit("cache.cold", T0, "s1", "coach", { resumeUSD: 5, freshUSD: 1 })], [old, fresh]).entries[0];
  assert.equal(e.status, "counted");
  assert.equal(e.savingUSD, 3.5); // 5.00 - 3 x 0.50
  assert.match(e.confidence, /derived resume cost, measured fresh-start cost/);
});

test("cold cache: ignored when it was resumed cold anyway or nothing followed; pending inside an hour", () => {
  const rows = [audit("cache.cold", T0, "s1", "coach", { resumeUSD: 5, freshUSD: 1 })];
  const cold = session("s1", "/p", T0 - 7200e3, [resp(T0 + 30e3, 5, 60, { coldUSD: 4 })]);
  assert.equal(ledger(rows, [cold]).entries[0].status, "ignored");
  assert.equal(ledger(rows, [cold]).entries[0].predictedUSD, 4);
  assert.equal(ledger(rows, [session("s1", "/p", T0 - 7200e3, [])]).entries[0].status, "ignored");
  assert.equal(ledger(rows, [session("s1", "/p", T0 - 7200e3, [])], T0 + 20 * MIN).entries[0].status, "pending");
});

// ---- plan-limit alerts (all sessions together)
const quotaRows = [audit("quota.projection", T0, "s1")];
const acct = (afterCost, afterN = 10, beforeCost = 0.4) => [session("s1", "/p", T0 - 3600e3, [...run(T0 - 30 * MIN + MIN, 10, beforeCost), ...run(T0 + MIN, afterN, afterCost)])];

test("quota alert: counted when spending fell to 70% or less and work continued; the saving is the 30-minute difference", () => {
  const e = ledger(quotaRows, acct(0.15)).entries[0]; // $4.00 before, $1.50 after
  assert.equal(e.status, "counted");
  assert.equal(e.savingUSD, 2.5);
  assert.match(e.confidence, /earlier pace is assumed/);
});

test("quota alert: ignored when spending did not slow, stopped when work ended (not credited), pending inside 30 minutes, no data without spending before", () => {
  assert.equal(ledger(quotaRows, acct(0.35)).entries[0].status, "ignored", "$3.50 after $4.00 is not 30% less");
  assert.equal(ledger(quotaRows, acct(0.1, 2)).entries[0].status, "stopped");
  assert.equal(ledger(quotaRows, acct(0.1), T0 + 10 * MIN).entries[0].status, "pending");
  assert.equal(ledger(quotaRows, acct(0.1, 10, 0.01)).entries[0].status, "no-data");
});

test("repeated alerts within 30 minutes are one intervention; a later one is another; quota alerts across sessions are one", () => {
  const rows = [audit("quota.five_hour", T0, "a"), audit("quota.seven_day", T0, "b"), audit("quota.projection", T0 + 20 * MIN, "a"), audit("quota.projection", T0 + 45 * MIN, "a"), audit("quota.projection", T0 + 2 * 3600e3, "a")];
  const iv = interventions(rows);
  assert.deepEqual(iv.map((i) => [i.family, i.rows]), [["quota", 4], ["quota", 1]], "gaps of 20 and 25 minutes chain; 75 minutes starts a new one");
  const per = interventions([audit("context.reset", T0, "a", "coach"), audit("context.reset", T0 + MIN, "b", "coach"), audit("context.reset", T0 + 2 * MIN, "a", "coach")]);
  assert.deepEqual(per.map((i) => [i.sessionId, i.rows]), [["a", 2], ["b", 1]], "reset alerts are per session");
});

test("a quota saving that overlaps a counted reset saving is not counted twice (and would count on its own)", () => {
  const tl = [...pre(), ...run(T0 + 5 * MIN, 30, 0.4, 30), ...run(T0 - 28 * MIN, 16, 2, 30)]; // heavy spending before the quota alert, light after
  const results = [session("s1", "/p", T0 - 3600e3, tl)];
  const quota = audit("quota.projection", T0 + 2 * MIN);
  const alone = ledger([quota], results);
  assert.equal(alone.entries[0].status, "counted", "control: with no reset, the slowdown counts");
  const both = ledger([audit("context.reset", T0), quota], results);
  const byFam = Object.fromEntries(both.entries.map((e) => [e.family, e]));
  assert.equal(byFam.reset.status, "counted");
  assert.equal(byFam.quota.status, "overlap");
  assert.equal(byFam.quota.countedUSD, alone.entries[0].savingUSD, "what it would have counted is kept for reference");
  assert.equal(both.totals.counted, 1);
  assert.equal(both.totals.countedUSD, byFam.reset.savingUSD, "only the reset saving is in the total");
  assert.equal(both.totals.overlap, 1);
});

test("alerts that are not savings-related (probe, loops, budgets) never enter the ledger; `since` limits the period", () => {
  const rows = [{ t: iso(T0), kind: "probe" }, audit("loop.identical_calls", T0), audit("budget.session", T0), audit("quota.five_hour", T0 - 3 * 86400e3)];
  assert.equal(ledger(rows, []).entries.length, 1);
  assert.equal(buildLedger({ auditRows: rows, results: [], now: NOW, sinceMs: T0 - 86400e3 }).entries.length, 0);
});

test("digest carries the week's ledger totals", () => {
  const l = ledger([audit("quota.projection", T0)], acct(0.15));
  assert.equal(buildDigest({ events: [], results: [], now: NOW, ledger: l }).ledger.countedUSD, 2.5);
  assert.equal(buildDigest({ events: [], results: [], now: NOW }).ledger, null);
});

// ---- command
test("sparelimit ledger: says there is nothing to count without alerts; lists entries with --json; unknown sessions are no-data, not savings", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-"));
  fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
  fs.copyFileSync(fixture("claude-code-session.jsonl"), path.join(home, ".claude", "projects", "p", "s.jsonl"));
  const sparelimit = (args) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { encoding: "utf8", env: { ...process.env, HOME: home, SPARELIMIT_HOME: sparelimitHome } });
  assert.match(sparelimit(["ledger"]).stdout, /nothing to count/);
  fs.writeFileSync(path.join(sparelimitHome, "audit.jsonl"), JSON.stringify(audit("context.reset", Date.now() - 86400e3, "no-such-session", "coach")) + "\n");
  const text = sparelimit(["ledger"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /COUNTED .*\$0\.00/);
  const j = JSON.parse(sparelimit(["ledger", "--json"]).stdout);
  assert.equal(j.entries[0].status, "no-data");
  assert.equal(j.totals.countedUSD, 0);
  assert.equal(sparelimit(["ledger", "--days=1"]).status, 0);
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), "ledger"], { encoding: "utf8", env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-")), SPARELIMIT_HOME: sparelimitHome } }).status, 1);
});

test("the ledger says how often alerts were acted on, out of those where acting or not could be told (X3)", () => {
  const old = session("s1", "/p", T0 - 3600e3, pre());
  const fresh = (project, pct) => session("s2", project, T0 + 10 * MIN, run(T0 + 10 * MIN, 30, 0.4, pct));
  const acted = ledger([audit("context.reset", T0)], [old, fresh("/p", 15)]).totals;
  assert.deepEqual([acted.actedOn, acted.ignored, acted.actedOnRate], [1, 0, 100]);
  const ignored = ledger([audit("context.reset", T0)], [old, fresh("/p", 60)]).totals;
  assert.deepEqual([ignored.actedOn, ignored.ignored, ignored.actedOnRate], [0, 1, 0]);
  assert.equal(ledger([], [old]).totals.actedOnRate, null, "no alerts: no rate");
});
