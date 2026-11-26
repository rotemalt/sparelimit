import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { digestPath, readDigest, scheduleDigest, digestLineOnce, writeDigest } from "../src/digestcache.mjs";
import { handleHook } from "../src/hook.mjs";
import { configPath, writeJsonAtomic } from "../src/state.mjs";
import { ROOT, fixture, tempSparelimitHome } from "./helpers.mjs";

const NOW = Date.parse("2026-11-05T15:00:00Z");
const DAY = 86400e3;
const digest = (over = {}) => ({ spend: { thisWeekUSD: 241, lastWeekUSD: 312, changePct: -23, weeklyLimitPct: 95 }, focus: { title: "Start fresh at ~60% of the window instead of waiting for auto-compaction", usd: 27, confidence: "estimated" }, ...over });

test("a background build starts when there is no digest or it is a week old, never while one is fresh or already running", () => {
  tempSparelimitHome();
  const calls = [];
  const spawnFn = (cmd, args) => calls.push(args[1]);
  assert.equal(scheduleDigest({ now: NOW, spawnFn }), true);
  assert.deepEqual(calls, ["__refresh-digest"]);
  assert.equal(scheduleDigest({ now: NOW + 1000, spawnFn }), false, "already running (lock)");
  tempSparelimitHome();
  writeDigest(digest(), NOW - 3 * DAY);
  assert.equal(scheduleDigest({ now: NOW, spawnFn }), false, "3 days old: still this week's");
  assert.equal(scheduleDigest({ now: NOW + 5 * DAY, spawnFn }), true, "8 days old");
  tempSparelimitHome();
  assert.equal(scheduleDigest({ now: NOW }), false, "tests and CI never start background processes");
});

test("the one-line summary is shown once per digest, with the focus habit, and not for stale or empty digests", () => {
  tempSparelimitHome();
  assert.equal(digestLineOnce({ now: NOW }), null, "nothing built yet");
  writeDigest(digest(), NOW - DAY);
  const line = digestLineOnce({ now: NOW });
  assert.match(line, /^Weekly digest: \$241 in the last 7 days, about 95% of a weekly limit \(-23% on the week before\)\./);
  assert.match(line, /Worth changing first: start fresh at ~60% of the window .* \(about \$27, estimated\)\./);
  assert.match(line, /Run `sparelimit digest`/);
  assert.equal(digestLineOnce({ now: NOW + 1000 }), null, "not repeated");
  writeDigest(digest(), NOW);
  assert.ok(digestLineOnce({ now: NOW + 1000 }), "a new digest is shown again");
  tempSparelimitHome();
  writeDigest(digest(), NOW - 20 * DAY);
  assert.equal(digestLineOnce({ now: NOW }), null, "older than two weeks");
  tempSparelimitHome();
  writeDigest(digest({ spend: { thisWeekUSD: 0 } }), NOW);
  assert.equal(digestLineOnce({ now: NOW }), null, "no spend, nothing to say");
  tempSparelimitHome();
  writeDigest(digest(), NOW, { shown: true });
  assert.equal(digestLineOnce({ now: NOW }), null, "read by hand counts as shown");
});

test("hook: the digest line reaches the user through the prompt hook once, and can be switched off", () => {
  tempSparelimitHome();
  writeDigest(digest(), NOW - DAY);
  const out = JSON.parse(handleHook("userpromptsubmit", { session_id: "d1" }, { now: NOW, refresh: false }).stdout);
  assert.match(out.systemMessage, /^\[sparelimit\] Weekly digest: \$241/);
  assert.equal(out.hookSpecificOutput, undefined, "not relayed to the model");
  assert.equal(handleHook("userpromptsubmit", { session_id: "d2" }, { now: NOW + 1000, refresh: false }).stdout, "", "once, across sessions");
  tempSparelimitHome();
  writeDigest(digest(), NOW - DAY);
  writeJsonAtomic(configPath(), { digest: { enabled: false } });
  assert.equal(handleHook("userpromptsubmit", { session_id: "d3" }, { now: NOW, refresh: false }).stdout, "");
});

test("tool-call hooks never show or use up the digest line", () => {
  tempSparelimitHome();
  writeDigest(digest(), NOW - DAY);
  assert.deepEqual(handleHook("pretooluse", { session_id: "d4", tool_name: "Bash", tool_input: { command: "ls" } }, { now: NOW, refresh: false }), { stdout: "", stderr: "", exit: 0 });
  assert.match(JSON.parse(handleHook("userpromptsubmit", { session_id: "d4" }, { now: NOW, refresh: false }).stdout).systemMessage, /Weekly digest/);
});

// ---- commands and dashboard
const homeWithSession = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-"));
  fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
  fs.copyFileSync(fixture("claude-code-session.jsonl"), path.join(home, ".claude", "projects", "p", "s.jsonl"));
  return home;
};

test("the background build writes the digest and clears its lock; reading `sparelimit digest` by hand marks it shown", () => {
  const sparelimitHome = tempSparelimitHome();
  const home = homeWithSession();
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { encoding: "utf8", env: { ...process.env, HOME: home, SPARELIMIT_HOME: sparelimitHome } });
  fs.writeFileSync(path.join(sparelimitHome, "digest.lock"), "{}");
  assert.equal(run(["__refresh-digest"]).status, 0);
  assert.ok(readDigest().digest.spend, "digest saved");
  assert.equal(fs.existsSync(path.join(sparelimitHome, "digest.lock")), false);
  fs.unlinkSync(digestPath());
  assert.equal(run(["digest"]).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(sparelimitHome, "digest-shown.json"), "utf8")).computedAt, readDigest().computedAt);
});

test("dashboard: /api/digest returns the digest, and a clear 503 without history", async () => {
  tempSparelimitHome();
  const { startServer } = await import("../sparelimit.mjs");
  const get = async (home) => {
    process.env.HOME = home;
    const server = startServer(null, null, 0);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/digest`);
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
    }
  };
  const log = console.log;
  console.log = () => {};
  try {
    const ok = await get(homeWithSession());
    assert.equal(ok.status, 200);
    assert.ok(ok.body.spend && Array.isArray(ok.body.swarms));
    const none = await get(fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-")));
    assert.equal(none.status, 503);
    assert.match(none.body.error, /no Claude Code transcripts/);
  } finally {
    console.log = log;
  }
});

test("dashboard: /api/history, /api/drains and /api/files answer from a real session, and 503 without history", async () => {
  tempSparelimitHome();
  const { startServer } = await import("../sparelimit.mjs");
  const get = async (home, route) => {
    process.env.HOME = home;
    const server = startServer(null, null, 0);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${route}`);
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
    }
  };
  const log = console.log;
  console.log = () => {};
  try {
    const home = homeWithSession();
    const h = await get(home, "/api/history");
    assert.equal(h.status, 200);
    assert.ok(Array.isArray(h.body.weekly) && Array.isArray(h.body.causes) && h.body.confidence === "derived");
    assert.equal((await get(home, "/api/drains")).status, 200);
    assert.equal((await get(home, "/api/files")).status, 200);
    const none = await get(fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-")), "/api/history");
    assert.equal(none.status, 503);
  } finally {
    console.log = log;
  }
});
