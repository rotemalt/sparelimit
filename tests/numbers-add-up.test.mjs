import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildLedger } from "../src/ledger.mjs";
import { buildWeek, renderWeekText } from "../src/week.mjs";
import { addsUp, breakdownEquation, breakdownFromTotals } from "../src/breakdown.mjs";
import { renderNumbersHtml, validateNumbers } from "../src/numbers.mjs";
import { ROOT, tempSparelimitHome } from "./helpers.mjs";

tempSparelimitHome();
const MIN = 60e3;
const T0 = Date.parse("2026-11-05T10:00:00Z");
const NOW = T0 + 24 * 3600e3;
const iso = (ms) => new Date(ms).toISOString();
const resp = (t, cost, pct = 30) => ({ t, cost, side: false, pct, exp: false, type: "edit", coldUSD: 0 });
const run = (from, n, cost, pct = 30) => Array.from({ length: n }, (_, i) => resp(from + i * MIN, cost, pct));
const session = (id, project, start, timeline) => ({ sessionId: id, project, start: iso(start), timeline });
const audit = (rule, t, sessionId = "s1") => ({ t: iso(t), kind: "coach", rule, sessionId, evidence: {} });
const good = session("s1", "/p", T0 - 3600e3, [...run(T0 - 12 * MIN, 12, 1, 70), ...run(T0 + 5 * MIN, 30, 0.4, 30)]);
const ignored = session("s2", "/q", T0 + 2 * 3600e3, [...run(T0 + 2 * 3600e3, 12, 1, 70), ...run(T0 + 2 * 3600e3 + 13 * MIN, 20, 1, 75)]);
const ledgers = {
  "one counted, one ignored": buildLedger({ auditRows: [audit("context.reset", T0), audit("context.reset", T0 + 2 * 3600e3 + 12 * MIN, "s2")], results: [good, ignored], now: NOW, weeklyLimitUSD: 250 }),
  "an alert with no session to judge it by": buildLedger({ auditRows: [audit("context.reset", T0), audit("context.reset", T0 + 5 * 3600e3, "nobody")], results: [good], now: NOW, weeklyLimitUSD: 250 }),
  "a very recent alert": buildLedger({ auditRows: [audit("context.reset", NOW - 5 * MIN)], results: [good], now: NOW, weeklyLimitUSD: 250 }),
  "nothing at all": buildLedger({ auditRows: [], results: [], now: NOW, weeklyLimitUSD: 250 })
};

test("every ledger the code can build: counted + ignored + unsettled + pending + work stopped (+ overlapping) = alerts that fired", () => {
  for (const [name, l] of Object.entries(ledgers)) {
    const b = breakdownFromTotals(l.totals);
    assert.ok(b.sums && addsUp(b), `${name}: ${breakdownEquation(b)}`);
    assert.equal(b.total, l.entries.length, name);
  }
});

test("the weekly summary prints the breakdown, and it adds up", () => {
  for (const [name, l] of Object.entries(ledgers)) {
    const w = buildWeek(l, { days: 7, now: NOW });
    assert.ok(addsUp(w.breakdown), name);
    if (w.alerts.value) assert.ok(renderWeekText(w).includes(`Where they went: ${breakdownEquation(w.breakdown)}`), name);
  }
});

const published = () => JSON.parse(fs.readFileSync(path.join(ROOT, "site", "numbers.json"), "utf8"));

test("the published breakdown adds up, is dated and says what it is a sample of", () => {
  const n = published();
  assert.deepEqual(validateNumbers(n), []);
  assert.ok(addsUp(n.breakdown), breakdownEquation(n.breakdown));
  assert.equal(n.breakdown.total, n.items.find((i) => i.id === "alerts").value);
  assert.equal(validateNumbers({ ...n, breakdown: { ...n.breakdown, total: n.breakdown.total + 1 } }).length > 0, true, "a sum that does not add up is caught");
});

test("the product page shows exactly the published numbers", () => {
  const html = fs.readFileSync(path.join(ROOT, "site", "index.html"), "utf8");
  assert.ok(html.includes(breakdownEquation(published().breakdown)), "the equation is on the page");
  assert.ok(html.includes(renderNumbersHtml(published())), "the block on the page is exactly what the file renders");
});

test("no tracked file claims money saved", () => {
  const files = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n").filter((f) => /\.(md|html|mjs|js|json|txt|yml|yaml)$/.test(f) && !f.startsWith("tests/") && f !== "package-lock.json");
  const bad = /money saved|saved you (money|\$)|you saved \$|saves you money|dollars saved|cash saved/i;
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.doesNotMatch(text, bad, f);
  }
});
