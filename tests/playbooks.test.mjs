import test from "node:test";
import assert from "node:assert/strict";
import { sanitizePlaybooks, evaluatePlaybooks } from "../src/playbooks.mjs";
import { handleHook } from "../src/hook.mjs";
import { loadConfig } from "../src/config.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const now = Date.parse("2026-11-07T12:00:00Z");
const inHours = (h) => Math.round((now + h * 3600e3) / 1000);

test("settings are checked: off by default, a bad rule is dropped and the others kept, thresholds are required where they mean something", () => {
  assert.deepEqual(sanitizePlaybooks(undefined), { enabled: false, dryRun: false, rules: [] });
  const c = sanitizePlaybooks({
    enabled: true,
    rules: [
      { id: "ok", when: "context-pct", atPct: 70, do: ["warn", "handoff", "nonsense"] },
      { id: "ok", when: "context-pct", atPct: 80, do: ["warn"] },
      { id: "no-threshold", when: "context-pct", do: ["warn"] },
      { id: "Bad Id", when: "context-pct", atPct: 70, do: ["warn"] },
      { id: "unknown-when", when: "moon-phase", do: ["warn"] },
      { id: "nothing-to-do", when: "context-pct", atPct: 70, do: ["nonsense"] },
      { id: "cost", when: "session-cost", atUSD: 5, do: ["warn"] },
      { id: "cost-bad", when: "session-cost", atUSD: -1, do: ["warn"] },
      { id: "forecast", when: "five-hour-runs-out", do: ["other-account"] }
    ]
  });
  assert.equal(c.enabled, true);
  assert.deepEqual(c.rules.map((r) => r.id), ["ok", "cost", "forecast"]);
  assert.deepEqual(c.rules[0].do, ["warn", "handoff"]);
});

test("a forecast rule fires when the window runs out before its reset, and only with enough used if atPct is set", () => {
  const snapshot = { model: "claude-opus-5-5", rateLimits: { fiveHour: { pct: 60, resetsAt: inHours(3) } }, burn: { fiveHourPctPerHour: 40 } };
  const config = sanitizePlaybooks({ enabled: true, rules: [{ id: "short", when: "five-hour-runs-out", atPct: 50, do: ["warn", "handoff", "cheaper-model", "other-account"] }, { id: "later", when: "five-hour-runs-out", atPct: 80, do: ["warn"] }] });
  const hits = evaluatePlaybooks({ snapshot, config, now, multiAccount: true });
  assert.deepEqual(hits.map((h) => h.id), ["short"]);
  assert.match(hits[0].message, /60% used/);
  assert.match(hits[0].message, /sparelimit reset/);
  assert.match(hits[0].message, /Sonnet/);
  assert.match(hits[0].message, /sparelimit plan --accounts/);
  const sonnet = evaluatePlaybooks({ snapshot: { ...snapshot, model: "claude-sonnet-5-5" }, config, now, multiAccount: false });
  assert.doesNotMatch(sonnet[0].message, /Sonnet|plan --accounts/, "a cheaper model is only suggested on Opus or Fable; accounts only when there are several");
  const lasts = evaluatePlaybooks({ snapshot: { ...snapshot, burn: { fiveHourPctPerHour: 5 } }, config, now });
  assert.deepEqual(lasts, [], "at 5%/h it lasts until the reset");
});

test("percent and cost rules, and nothing at all when switched off", () => {
  const config = sanitizePlaybooks({ enabled: true, rules: [{ id: "ctx", when: "context-pct", atPct: 70, do: ["warn"] }, { id: "wk", when: "seven-day-pct", atPct: 90, do: ["warn"] }, { id: "usd", when: "session-cost", atUSD: 10, do: ["warn"] }] });
  const snapshot = { contextPct: 72, costUsd: 9.5, rateLimits: { sevenDay: { pct: 91, resetsAt: inHours(24) } } };
  assert.deepEqual(evaluatePlaybooks({ snapshot, config, now }).map((h) => h.id), ["ctx", "wk"]);
  assert.deepEqual(evaluatePlaybooks({ snapshot, config: { ...config, enabled: false }, now }), []);
});

test("in the prompt hook: a rule speaks once, a dry run speaks to nobody but is logged, and a project file cannot change your playbooks", () => {
  const vh = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-pb-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-pb-proj-"));
  process.env.SPARELIMIT_HOME = vh;
  fs.mkdirSync(path.join(vh, "live"), { recursive: true });
  fs.writeFileSync(path.join(vh, "live", "s1.json"), JSON.stringify({ sessionId: "s1", receivedAtMs: now, contextPct: 75, costUsd: 1, rateLimits: {} }));
  const write = (o) => fs.writeFileSync(path.join(vh, "config.json"), JSON.stringify(o));
  const input = { session_id: "s1", cwd: proj };
  write({ delivery: { desktop: false }, digest: { enabled: false }, policy: { context: { warnPct: null, blockPct: null } }, playbooks: { enabled: true, rules: [{ id: "ctx", when: "context-pct", atPct: 70, do: ["warn", "handoff"] }] } });
  const first = handleHook("userpromptsubmit", input, { now, refresh: false, notifyFn: () => {} });
  assert.match(JSON.parse(first.stdout).systemMessage, /Playbook "ctx": the context window is 75% full/);
  assert.equal(handleHook("userpromptsubmit", input, { now: now + 60e3, refresh: false, notifyFn: () => {} }).stdout, "", "once per 10 minutes");
  write({ delivery: { desktop: false }, digest: { enabled: false }, policy: { context: { warnPct: null, blockPct: null } }, playbooks: { enabled: true, dryRun: true, rules: [{ id: "ctx", when: "context-pct", atPct: 70, do: ["warn"] }] } });
  fs.rmSync(path.join(vh, "state"), { recursive: true, force: true });
  assert.equal(handleHook("userpromptsubmit", input, { now, refresh: false, notifyFn: () => {} }).stdout, "", "a dry run shows nothing");
  const audit = fs.readFileSync(path.join(vh, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.kind === "playbook");
  assert.deepEqual(audit.map((r) => r.dryRun), [false, true]);
  fs.mkdirSync(path.join(proj, ".sparelimit"));
  fs.writeFileSync(path.join(proj, ".sparelimit", "config.json"), JSON.stringify({ playbooks: { enabled: false } }));
  assert.equal(loadConfig({ cwd: proj, globalFile: path.join(vh, "config.json") }).playbooks.enabled, true, "yours stay in force");
});
