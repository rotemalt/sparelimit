import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, tempSparelimitHome } from "./helpers.mjs";
import { FAMILIES, LEDGER, LEDGER_RULES_VERSION, STATUSES, buildLedger } from "../src/ledger.mjs";
import { renderRulesMd, rulesHash, rulesSnapshot } from "../src/rules.mjs";
import { buildWeek, renderWeekText } from "../src/week.mjs";

tempSparelimitHome();
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const lock = JSON.parse(read("docs", "rules-lock.json"));

test("the rules in docs/RULES.md are the code's rules: the file is exactly what the code generates", () => {
  assert.equal(read("docs", "RULES.md"), renderRulesMd(), "run `node scripts/build-rules.mjs` after changing a rule or its version");
});

test("a rule or a threshold cannot change without a new version", () => {
  const entry = lock.versions[LEDGER_RULES_VERSION];
  assert.ok(entry, `the current rules version (${LEDGER_RULES_VERSION}) has no entry in docs/rules-lock.json; run node scripts/build-rules.mjs --lock`);
  assert.equal(rulesHash(), entry.sha256, `the rules changed and the version did not: raise LEDGER_RULES_VERSION in src/ledger.mjs, add the version to docs/CHANGELOG.md, then run node scripts/build-rules.mjs --lock. Never edit an old entry.`);
  assert.deepEqual(entry.thresholds, LEDGER);
  assert.deepEqual(entry.families, FAMILIES);
});

test("every version in the lock has a changelog entry, and the lock never skips or loses a version", () => {
  const changelog = read("docs", "CHANGELOG.md");
  const versions = Object.keys(lock.versions).map(Number).sort((a, b) => a - b);
  assert.ok(versions.length >= 1);
  versions.forEach((v, i) => {
    assert.equal(v, i + 1, "versions are 1, 2, 3 ... with none missing");
    assert.match(changelog, new RegExp(`## Version ${v} \\(`), `docs/CHANGELOG.md has no entry for version ${v}`);
  });
  assert.equal(Math.max(...versions), LEDGER_RULES_VERSION, "the code's version is the newest in the lock");
});

test("the changelog keeps version 1's numbers exactly as they were", () => {
  const changelog = read("docs", "CHANGELOG.md");
  const v1 = lock.versions[1];
  const section = changelog.split("## Version 1")[1].split(/\n## Version 2/)[0];
  for (const [k, v] of Object.entries(v1.thresholds)) assert.ok(section.includes(`| \`${k}\` | ${v} |`), `version 1 ${k} = ${v} must stay in the changelog`);
  for (const [k, v] of Object.entries(v1.thresholds)) assert.equal(typeof v, "number", k);
});

test("the statuses are the places an alert can end, and the ledger only ever produces those", () => {
  assert.deepEqual(STATUSES, ["counted", "ignored", "no-data", "pending", "stopped", "overlap"]);
  const l = buildLedger({ auditRows: [{ t: new Date().toISOString(), kind: "finding", rule: "quota.five_hour", evidence: {} }], results: [], now: Date.now() });
  for (const e of l.entries) assert.ok(STATUSES.includes(e.status), e.status);
});

test("the rules version is printed by the ledger, the weekly summary and the published numbers", () => {
  const l = buildLedger({ auditRows: [], results: [], now: Date.now() });
  assert.equal(l.rulesVersion, LEDGER_RULES_VERSION);
  const w = buildWeek({ ...l, entries: [], totals: { ...l.totals } }, { days: 7 });
  assert.equal(w.rulesVersion, LEDGER_RULES_VERSION);
  const withAlert = { ...w, alerts: { value: 1, label: "derived" }, breakdown: { total: 1, parts: [{ id: "counted", word: "counted", n: 1 }], label: "derived" } };
  assert.match(renderWeekText(withAlert), new RegExp(`Rules version ${LEDGER_RULES_VERSION}`));
  assert.equal(JSON.parse(read("site", "numbers.json")).rules_version, LEDGER_RULES_VERSION);
  const r = spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), "ledger", "--json"], { encoding: "utf8", env: { ...process.env, HOME: ROOT, SPARELIMIT_NO_CACHE: "1", SPARELIMIT_NO_REFRESH: "1" } });
  if (r.status === 0) assert.equal(JSON.parse(r.stdout).rulesVersion, LEDGER_RULES_VERSION);
});

test("no number that decides an outcome is written in the evaluators: they use the table", () => {
  const src = read("src", "ledger.mjs");
  const body = src.slice(src.indexOf("function evalReset"), src.indexOf("export function buildLedger"));
  const stray = [...body.matchAll(/(?<![\w.$])(?:\*\s*0\.\d+|<\s*\d+\b|slice\(0,\s*\d+\)|3600e3)/g)].map((m) => m[0]).filter((m) => !/LEDGER/.test(m));
  assert.deepEqual(stray.filter((m) => !/slice\(0, 0\)/.test(m) && m !== "3600e3"), [], "write each threshold in LEDGER, not in the evaluator");
});

test("the rules text names every threshold that decides an outcome", () => {
  const md = read("docs", "RULES.md");
  for (const k of Object.keys(LEDGER)) assert.ok(md.includes(`\`${k}\``), `${k} is in the threshold table`);
  assert.equal(rulesSnapshot().version, LEDGER_RULES_VERSION);
});
