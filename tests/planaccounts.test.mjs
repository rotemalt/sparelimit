import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { planScope, currentConfigDir, defaultConfigDir, resolveAccount } from "../src/accounts.mjs";
import { loadCalibration, addCalibrationPoint, calibrationPath } from "../src/planestimate.mjs";
import { cacheEvents } from "../src/plancache.mjs";
import { ROOT, tempSparelimitHome } from "./helpers.mjs";

const home = "/h/u";
const A = path.join(home, ".claude");
const B = path.join(home, ".claude-work");

test("the current account is the shell's: CLAUDE_CONFIG_DIR if set, else the default folder", () => {
  assert.equal(currentConfigDir({ home, env: {} }), A);
  assert.equal(currentConfigDir({ home, env: { CLAUDE_CONFIG_DIR: B } }), B);
  assert.equal(defaultConfigDir({ home }), A);
});

test("scope: a log in another known folder is excluded; Desktop agent sessions count for the default account only; a log in no known folder is counted", () => {
  const known = [A, B];
  const inA = path.join(A, "projects", "p", "s.jsonl");
  const inB = path.join(B, "projects", "p", "s.jsonl");
  const desk = "/Library/Application Support/Claude/local-agent-mode-sessions/a/b/local_c/.claude/projects/-sessions-x/s.jsonl";
  const stray = "/tmp/other/s.jsonl";
  const forA = planScope(A, known, { home });
  const forB = planScope(B, known, { home });
  assert.deepEqual([inA, inB, desk, stray].map(forA), [true, false, true, true]);
  assert.deepEqual([inA, inB, desk, stray].map(forB), [false, true, false, true]);
});

test("calibration is per account: points with no account are the default folder's, a point for another account is tagged and kept apart, and writing one never drops another's", () => {
  tempSparelimitHome();
  const realDefault = defaultConfigDir();
  const other = path.join(path.dirname(realDefault), ".claude-test-other");
  const ev = (usd) => [{ t: Date.now() - 600e3, cost: usd }];
  addCalibrationPoint({ at: Date.now(), fivePct: 40, weeklyPct: null, weeklyResetMs: null, events: ev(20), account: realDefault });
  addCalibrationPoint({ at: Date.now() + 1, fivePct: 20, weeklyPct: null, weeklyResetMs: null, events: ev(3), account: other });
  const raw = JSON.parse(fs.readFileSync(calibrationPath(), "utf8")).points;
  assert.equal(raw.length, 2, "both are in the file");
  assert.equal(raw[0].account, undefined, "the default folder's points carry no account, as before accounts existed");
  assert.equal(raw[1].account, other);
  assert.deepEqual(loadCalibration({ account: realDefault }).points.map((p) => p.fivePct), [40]);
  assert.deepEqual(loadCalibration({ account: other }).points.map((p) => p.fivePct), [20]);
  addCalibrationPoint({ at: Date.now() + 2, fivePct: 50, weeklyPct: null, weeklyResetMs: null, events: ev(25), account: realDefault });
  assert.equal(JSON.parse(fs.readFileSync(calibrationPath(), "utf8")).points.length, 3, "a second default point did not drop the other account's");
  assert.deepEqual(loadCalibration({ account: other }).points.map((p) => p.fivePct), [20]);
});

test("cached events can be filtered by account", () => {
  const cache = { days: 8, files: { "/h/u/.claude/projects/p/a.jsonl": { events: [[10, 1]] }, "/h/u/.claude-work/projects/p/b.jsonl": { events: [[20, 5]] } } };
  assert.deepEqual(cacheEvents(cache, 0).map((e) => e.cost), [1, 5], "no scope: every account, as before");
  assert.deepEqual(cacheEvents(cache, 0, planScope(B, [A, B], { home })).map((e) => e.cost), [5]);
});

test("a name, a path or the start of an id picks one account; nothing or several is null", () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-pa-"));
  const mkdir = (d) => fs.mkdirSync(path.join(h, d, "projects"), { recursive: true });
  mkdir(".claude");
  mkdir(".claude-a");
  mkdir(".claude-b");
  fs.writeFileSync(path.join(h, ".claude-a", ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "org-a-1234", organizationName: "Acme" } }));
  fs.writeFileSync(path.join(h, ".claude-b", ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "org-b-9999", organizationName: "Acme" } }));
  const dirs = [".claude", ".claude-a", ".claude-b"].map((d) => path.join(h, d));
  assert.equal(resolveAccount(dirs[1], dirs, { home: h }), dirs[1], "a path");
  assert.equal(resolveAccount("Acme", dirs, { home: h }), null, "two accounts with the same name: ambiguous");
  assert.equal(resolveAccount("Acme", dirs, { home: h, labels: { [dirs[1]]: "Client A" } }), dirs[2], "after naming one, the other is unique");
  assert.equal(resolveAccount("client a", dirs, { home: h, labels: { [dirs[1]]: "Client A" } }), dirs[1], "not case-sensitive");
  assert.equal(resolveAccount("nothing", dirs, { home: h }), null);
  assert.equal(resolveAccount("", dirs, { home: h }), null);
});

test("end to end: two accounts, each calibrated on its own, each estimated from its own folder's spend only; the planner ranks them", () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-e2e-pa-"));
  const mk = (dir, id, n) => {
    fs.mkdirSync(path.join(h, dir, "projects", "-p"), { recursive: true });
    const lines = Array.from({ length: n }, (_, i) => JSON.stringify({ type: "assistant", sessionId: id, uuid: `${id}${i}`, timestamp: new Date(Date.now() - (n - i) * 60e3).toISOString(), message: { id: `${id}${i}`, model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 0, output_tokens: 100 }, content: [] } }));
    fs.writeFileSync(path.join(h, dir, "projects", "-p", `${id}.jsonl`), lines.join("\n") + "\n");
  };
  mk(".claude", "s-main", 2); // little spend
  mk(".claude-work", "s-work", 10); // five times the spend
  fs.writeFileSync(path.join(h, ".claude-work", ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "org-w", organizationName: "Acme Corp" } }));
  const vh = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-state-"));
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...a], { encoding: "utf8", env: { ...process.env, HOME: h, SPARELIMIT_HOME: vh, SPARELIMIT_NO_REFRESH: "1", SPARELIMIT_NO_CACHE: "1", CLAUDE_CONFIG_DIR: "" } });
  const strip = (t) => t.replace(/\x1b\[[0-9;]*m/g, "");
  // both calibrated at "50% used" with their own spend, so the limit of the busier one comes out five times larger
  assert.equal(run("calibrate", "--five=50").status, 0);
  assert.equal(run("calibrate", "--account=Acme Corp", "--five=50").status, 0);
  const cal = JSON.parse(fs.readFileSync(path.join(vh, "calibration.json"), "utf8")).points;
  assert.equal(cal.length, 2);
  assert.equal(cal.filter((p) => p.account).length, 1, "only the non-default point is tagged");
  const ratio = cal.find((p) => p.account).spendFive / cal.find((p) => !p.account).spendFive;
  assert.ok(ratio > 4 && ratio < 6, `the work account's calibration used its own 5x spend (got ${ratio.toFixed(2)})`);
  const planner = strip(run("plan", "--accounts").stdout);
  assert.match(planner, /PLAN PLANNER/);
  assert.match(planner, /api-key or unknown/, "the default folder here has no account file");
  assert.match(planner, /Acme Corp/);
  assert.match(planner, /Most headroom now:/);
  const own = strip(run("plan", "--account=Acme Corp").stdout);
  assert.match(own, /5-hour/);
  assert.equal(run("plan", "--account=nope").status, 2);
  assert.equal(run("calibrate", "--account=nope", "--five=10").status, 2);
});

test("dashboard: /api/planner returns each account's outlook (null until calibrated), and the card renders text only", async () => {
  const { startServer } = await import("../sparelimit.mjs");
  const saved = { HOME: process.env.HOME, V: process.env.SPARELIMIT_HOME, C: process.env.CLAUDE_CONFIG_DIR };
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-planner-"));
  fs.mkdirSync(path.join(h, ".claude", "projects", "-p"), { recursive: true });
  fs.mkdirSync(path.join(h, ".claude-work", "projects", "-p"), { recursive: true });
  process.env.HOME = h;
  process.env.SPARELIMIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-state-"));
  delete process.env.CLAUDE_CONFIG_DIR;
  const server = startServer(null, null, 0);
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/planner`);
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.accounts.length, 2);
    assert.ok(j.accounts.every((a) => a.calibratedPoints === 0 && a.fiveHour === null), "nothing is invented before calibration");
    assert.equal(j.mostHeadroom, null);
    assert.equal(j.confidence, "estimated from your logs, per account");
  } finally {
    server.close();
    for (const [k, v] of [["HOME", saved.HOME], ["SPARELIMIT_HOME", saved.V], ["CLAUDE_CONFIG_DIR", saved.C]]) v == null ? delete process.env[k] : (process.env[k] = v);
  }
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  assert.doesNotMatch(app.slice(app.indexOf("async function initPlanner")), /innerHTML|insertAdjacentHTML|document\.write/);
});
