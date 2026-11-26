import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildLedger } from "../src/ledger.mjs";
import { buildWeek, renderWeekText } from "../src/week.mjs";
import { ROOT, fixture, tempSparelimitHome } from "./helpers.mjs";

const sparelimitHome = tempSparelimitHome();
const MIN = 60e3;
const T0 = Date.parse("2026-11-05T10:00:00Z");
const NOW = T0 + 24 * 3600e3;
const iso = (ms) => new Date(ms).toISOString();
const resp = (t, cost, pct = 30) => ({ t, cost, side: false, pct, exp: false, type: "edit", coldUSD: 0 });
const run = (from, n, cost, pct = 30) => Array.from({ length: n }, (_, i) => resp(from + i * MIN, cost, pct));
const session = (id, project, start, timeline) => ({ sessionId: id, project, start: iso(start), timeline });
const audit = (rule, t, sessionId = "s1", evidence = {}) => ({ t: iso(t), kind: "coach", rule, sessionId, evidence });
const ledgerOf = (auditRows, results) => buildLedger({ auditRows, results, now: NOW, weeklyLimitUSD: 250 });
const pre = () => run(T0 - 12 * MIN, 12, 1, 70);

// one counted reset ($18), one ignored
const goodSession = session("s1", "/p", T0 - 3600e3, [...pre(), ...run(T0 + 5 * MIN, 30, 0.4, 30)]);
const ignoredSession = session("s2", "/q", T0 + 2 * 3600e3, [...run(T0 + 2 * 3600e3, 12, 1, 70), ...run(T0 + 2 * 3600e3 + 13 * MIN, 20, 1, 75)]);

test("the summary's numbers are the ledger's numbers", () => {
  const l = ledgerOf([audit("context.reset", T0), audit("context.reset", T0 + 2 * 3600e3 + 12 * MIN, "s2")], [goodSession, ignoredSession]);
  const w = buildWeek(l, { days: 7, now: NOW });
  assert.equal(w.alerts.value, l.totals.interventions);
  assert.equal(w.actedOn.value, l.totals.actedOn);
  assert.equal(w.ignored.value, l.totals.ignored);
  assert.equal(w.counted.savingUSD, l.totals.countedUSD);
  assert.equal(w.counted.savingUSD, 18);
});

test("every figure carries a label, and a counted saving is never more certain than estimated", () => {
  const w = buildWeek(ledgerOf([audit("context.reset", T0)], [goodSession]), { now: NOW });
  for (const f of [w.alerts, w.actedOn, w.ignored, w.counted]) assert.match(f.label, /^(exact|derived|estimated)$/);
  assert.equal(w.counted.label, "estimated");
  assert.equal(w.alerts.label, "derived");
});

test("what was not counted is listed with its reason, and ignored alerts show what they predicted without counting it", () => {
  const w = buildWeek(ledgerOf([audit("context.reset", T0 + 2 * 3600e3 + 12 * MIN, "s2", { savingUSD: 7 })], [ignoredSession]), { now: NOW });
  assert.equal(w.counted.savingUSD, 0);
  const ig = w.notCounted.find((x) => x.reason === "ignored");
  assert.deepEqual([ig.n, ig.predictedUSD], [1, 7]);
  assert.match(renderWeekText(w), /1 ignored/);
});

test("a counted saving that came out negative is shown as it is", () => {
  const bad = session("s1", "/p", T0 - 3600e3, [...pre(), ...run(T0 + 5 * MIN, 30, 1.5, 30)]);
  const w = buildWeek(ledgerOf([audit("context.reset", T0)], [bad]), { now: NOW });
  assert.equal(w.counted.savingUSD, -15, "the ledger's own figure is kept");
});

test("the summary names no price and takes no money", () => {
  const w = buildWeek(ledgerOf([audit("context.reset", T0)], [goodSession]), { now: NOW });
  assert.doesNotMatch(JSON.stringify(w) + renderWeekText(w), /charg|5%|"price"|offer/i);
});

test("with no alerts it says there is nothing to count instead of printing zeros as a result", () => {
  const w = buildWeek(ledgerOf([], [goodSession]), { now: NOW });
  assert.equal(w.alerts.value, 0);
  assert.match(renderWeekText(w), /nothing to count/);
});

test("sparelimit week --json equals sparelimit ledger --json for the same days, and the week text runs", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-"));
  fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
  fs.copyFileSync(fixture("claude-code-session.jsonl"), path.join(home, ".claude", "projects", "p", "s.jsonl"));
  fs.writeFileSync(path.join(sparelimitHome, "audit.jsonl"), JSON.stringify(audit("context.reset", Date.now() - 86400e3, "no-such-session")) + "\n");
  const sparelimit = (args) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { encoding: "utf8", env: { ...process.env, HOME: home, SPARELIMIT_HOME: sparelimitHome } });
  const week = JSON.parse(sparelimit(["week", "--json"]).stdout);
  const ledger = JSON.parse(sparelimit(["ledger", "--json", "--days=7"]).stdout);
  assert.equal(week.alerts.value, ledger.totals.interventions);
  assert.equal(week.counted.savingUSD, ledger.totals.countedUSD);
  assert.equal(week.actedOn.value, ledger.totals.actedOn);
  const text = sparelimit(["week"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /WEEKLY SUMMARY/);
  assert.equal(spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), "week"], { encoding: "utf8", env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-")), SPARELIMIT_HOME: sparelimitHome } }).status, 1, "no transcripts: it says so and exits 1");
});
