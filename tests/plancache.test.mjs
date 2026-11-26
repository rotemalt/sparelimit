import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshPlanCache, cacheEvents, planEstimateFromCache, scheduleRefresh, cachePath } from "../src/plancache.mjs";
import { handleHook } from "../src/hook.mjs";
import { calibrationPath } from "../src/planestimate.mjs";
import { snapshotPath, configPath, writeJsonAtomic } from "../src/state.mjs";
import { fixture, tempSparelimitHome } from "./helpers.mjs";

const NOW = Date.parse("2026-11-05T12:00:00Z");

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-root-"));
  const proj = path.join(root, "-proj");
  fs.mkdirSync(proj);
  const file = path.join(proj, "11111111-1111-1111-1111-111111111111.jsonl");
  fs.copyFileSync(fixture("claude-code-session.jsonl"), file);
  fs.utimesSync(file, new Date(NOW), new Date(NOW));
  return { root, file };
}

test("first refresh parses a session, the second reuses it, and a changed file (or new subagent file) is parsed again", async () => {
  tempSparelimitHome();
  const { root, file } = makeRoot();
  let r = await refreshPlanCache({ now: NOW, root });
  assert.deepEqual([r.parsed, r.reused], [1, 0]);
  assert.equal(cacheEvents(r.cache).length, 3);
  r = await refreshPlanCache({ now: NOW, root });
  assert.deepEqual([r.parsed, r.reused], [0, 1]);
  fs.appendFileSync(file, fs.readFileSync(file, "utf8").split("\n")[2] + "\n"); // the session grew
  r = await refreshPlanCache({ now: NOW, root });
  assert.equal(r.parsed, 1);
  const sub = path.join(root, "-proj", "11111111-1111-1111-1111-111111111111", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-1.jsonl"), "{}\n"); // a subagent file appeared
  r = await refreshPlanCache({ now: NOW, root });
  assert.equal(r.parsed, 1);
});

test("events older than the window are not kept, and cacheEvents is sorted", async () => {
  tempSparelimitHome();
  const { root } = makeRoot();
  const r = await refreshPlanCache({ now: NOW + 30 * 86400e3, root, days: 8 });
  assert.equal(cacheEvents(r.cache).length, 0);
  assert.ok(fs.existsSync(cachePath()));
  const sorted = cacheEvents({ days: 8, files: { a: { events: [[3, 1], [1, 1]] }, b: { events: [[2, 1]] } } });
  assert.deepEqual(sorted.map((e) => e.t), [1, 2, 3]);
});

test("a background refresh starts only when the cache is old and none is already running", () => {
  tempSparelimitHome();
  const calls = [];
  const spawnFn = (...a) => calls.push(a);
  assert.equal(scheduleRefresh({ now: NOW, spawnFn }), true, "no cache yet");
  assert.equal(scheduleRefresh({ now: NOW + 10_000, spawnFn }), false, "a refresh was just started (lock)");
  writeJsonAtomic(cachePath(), { computedAt: NOW + 200_000, days: 8, files: {} });
  assert.equal(scheduleRefresh({ now: NOW + 210_000, spawnFn }), false, "cache is fresh");
  assert.equal(scheduleRefresh({ now: NOW + 400_000, spawnFn }), true, "cache is old and the lock expired");
  assert.equal(calls.length, 2);
});

// ---- hook fallback to the estimate (the Desktop app has no status line)
const T = Date.UTC(2026, 10, 5, 12, 56);
function setup({ cacheAgeMs = 5_000, calibrate = true } = {}) {
  tempSparelimitHome();
  if (calibrate) writeJsonAtomic(calibrationPath(), { points: [{ at: "2026-11-05T11:56:00Z", fivePct: 97, spendFive: 28.47, weeklyPct: 90, spendWeek: 225.89, weeklyResetMs: Date.UTC(2026, 10, 6, 13) }] });
  // 28.00 spent in the 11:00-16:00 window = 95% of a $29.35 limit
  writeJsonAtomic(cachePath(), { version: 1, computedAt: T - cacheAgeMs, days: 8, files: { a: { sig: "s", events: [[Date.UTC(2026, 10, 5, 11, 30), 14], [Date.UTC(2026, 10, 5, 12, 46), 14]] } } });
}
const prompt = (o) => handleHook("userpromptsubmit", { session_id: "s1" }, { now: T, refresh: false, ...o });
const tool = (o) => handleHook("pretooluse", { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }, { now: T, refresh: false, ...o });

test("no exact quota numbers: the hook warns from the estimate, says it is estimated, and does not hard-block by default", () => {
  setup();
  const w = JSON.parse(prompt().stdout);
  assert.match(w.systemMessage, /5-hour quota is 95% used/);
  assert.match(w.systemMessage, /estimated from your logs/);
  assert.equal(tool().exit, 0, "an estimate alone must not block");
});

test("the user can opt in to blocking on estimates", () => {
  setup();
  writeJsonAtomic(configPath(), { policy: { quota: { blockOnEstimated: true } } });
  const r = tool();
  assert.equal(r.exit, 2);
  assert.match(r.stderr, /estimated from your logs/);
});

test("exact numbers from the status line take precedence over the estimate", () => {
  setup();
  writeJsonAtomic(snapshotPath("s1"), { sessionId: "s1", receivedAtMs: T - 1000, rateLimits: { fiveHour: { pct: 10, resetsAt: T / 1000 + 3600 } } });
  assert.equal(prompt().stdout, "");
  assert.equal(tool().exit, 0);
});

test("without calibration, or with an old cache, the hook says nothing about the plan", () => {
  setup({ calibrate: false });
  assert.equal(prompt().stdout, "");
  setup({ cacheAgeMs: 20 * 60e3 });
  assert.equal(prompt().stdout, "");
});

test("planEstimateFromCache reports cache age and returns null without data", () => {
  tempSparelimitHome();
  assert.equal(planEstimateFromCache({ now: T, cache: null }), null);
  setup();
  const est = planEstimateFromCache({ now: T });
  assert.equal(est.cacheAgeMs, 5_000);
  assert.ok(Math.abs(est.fiveHour.pct - 95.4) < 0.5);
});
