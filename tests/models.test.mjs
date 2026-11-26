import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { taskType, modelReport, summarizeModels, RISK } from "../src/models.mjs";
import { buildHabitCard } from "../src/habits.mjs";
import { buildDigest } from "../src/digest.mjs";
import { priceEvent } from "../src/analyze.mjs";
import { loadPricing } from "../src/pricing.mjs";
import { ROOT, fixture, tempSparelimitHome } from "./helpers.mjs";

const sparelimitHome = tempSparelimitHome();
const pricing = loadPricing();
const ev = (model, tools, calls = [], side = false) => ({ id: Math.random().toString(36), ts: "2026-11-05T10:00:00Z", model, isSidechain: side, usage: { input: 10, cacheRead: 100_000, cacheWrite5m: 0, cacheWrite1h: 0, output: 500 }, context: 100_010, tools, calls, confidence: "derived" });
const pricedOf = (events) => events.map((e) => ({ ev: e, ...priceEvent(e, pricing) }));

test("task type is what the response did: no tool = think, only Bash = run, reads = explore, any edit = edit, Task = delegate", () => {
  assert.equal(taskType(ev("m", [])), "think");
  assert.equal(taskType(ev("m", ["Bash"])), "run");
  assert.equal(taskType(ev("m", ["Read", "Grep"])), "explore");
  assert.equal(taskType(ev("m", ["Read", "Edit"])), "edit");
  assert.equal(taskType(ev("m", ["Task", "Edit"])), "delegate");
  assert.equal(taskType(ev("m", ["mcp__Claude_Browser__computer"])), "mcp");
  assert.equal(taskType(ev("m", ["Bash", "Read"])), "mixed");
  assert.deepEqual([RISK.run, RISK.edit, RISK.think], ["low", "medium", "high"]);
});

test("what-if: Opus work is priced on Sonnet 5.5 and Fable work on Opus 5.5 (real price table); Sonnet work is not a candidate", () => {
  const opus = ev("claude-opus-5-5", ["Bash"]);
  const sonnet = ev("claude-sonnet-5-5", ["Bash"]);
  const fable = ev("claude-fable-5-1", []);
  const r = modelReport(pricedOf([opus, sonnet, fable]), pricing);
  const cost = (e, m) => priceEvent(e, pricing, m).cost;
  assert.ok(Math.abs(r.tasks.run.usd - cost(opus)) < 0.01);
  assert.ok(Math.abs(r.tasks.run.savingUSD - (cost(opus) - cost(opus, "claude-sonnet-5-5"))) < 0.01);
  assert.ok(Math.abs(r.tasks.think.savingUSD - (cost(fable) - cost(fable, "claude-opus-5-5"))) < 0.01);
  assert.equal(r.tasks.run.responses, 1, "the Sonnet response is not counted");
});

test("failure rates by model family count only calls whose result is known, and need 50 calls before they are shown", () => {
  const calls = (n, bad) => Array.from({ length: n }, (_, i) => ({ name: "Bash", sig: "s", res: i < bad ? "!x" : "ok" }));
  const mk = (model, n, bad) => modelReport(pricedOf([ev(model, ["Bash"], [...calls(n, bad), { name: "Bash", sig: "s" }])]), pricing);
  const s = summarizeModels([mk("claude-opus-5-5", 100, 2), mk("claude-sonnet-5-5", 100, 4)]);
  assert.deepEqual(s.evidence, [{ type: "run", opus: { calls: 100, failedPct: 2 }, sonnet: { calls: 100, failedPct: 4 } }]);
  assert.deepEqual(summarizeModels([mk("claude-opus-5-5", 10, 1), mk("claude-sonnet-5-5", 10, 1)]).evidence, [], "too few calls to say anything");
});

test("summary: tiers add up by risk, subagent types are ranked by their spend on expensive models", () => {
  const rep = modelReport(pricedOf([ev("claude-opus-5-5", ["Bash"]), ev("claude-opus-5-5", ["Edit"]), ev("claude-opus-5-5", [])]), pricing);
  const s = summarizeModels([rep], [[{ type: "coder", model: "claude-opus-5-5", costUSD: 3 }, { type: "coder", model: "claude-sonnet-5-5", costUSD: 1 }, { type: "researcher", model: "claude-opus-5-5", costUSD: 5 }]]);
  const sum = (risk) => s.rows.filter((r) => r.risk === risk).reduce((n, r) => n + r.savingUSD, 0);
  assert.ok(Math.abs(s.tierSavingUSD.low - sum("low")) < 0.01 && s.tierSavingUSD.low > 0);
  assert.ok(s.tierSavingUSD.medium > 0 && s.tierSavingUSD.high > 0);
  assert.deepEqual(s.subagentTypes.map((x) => [x.type, x.agents, x.expensiveUSD]), [["researcher", 1, 5], ["coder", 2, 3]]);
});

test("card: with the model advisor's data the model row is the low-risk move with a range and the user's failure rates; without it, the old half-of-Opus row", () => {
  const base = { sessions: 1, totalCostUSD: 1000, firstStart: "2026-10-01T00:00:00Z", lastEnd: "2026-10-08T00:00:00Z", earlierReset: { sessionsModelled: 0, netSavingUSD: 0, netSavingLowUSD: 0, netSavingHighUSD: 0 }, breaks: { messages: 0, over60min: 0, savingUSD: 0 }, opusHalfToSonnetUSD: 100, byModelUSD: { opus: 500 }, sidechainUSD: 0, spendBreakdownUSD: { startContextUSD: 0 }, toolOutputCarryUSD: {} };
  assert.ok(buildHabitCard(base).savings.some((h) => h.id === "model-mix"));
  const models = { rows: [{ type: "run" }], tierSavingUSD: { low: 300, medium: 100, high: 20 }, evidence: [{ type: "run", opus: { calls: 100, failedPct: 1.7 }, sonnet: { calls: 100, failedPct: 2.2 } }] };
  const row = buildHabitCard({ ...base, models }).savings.find((h) => h.id === "model-low-risk");
  assert.equal(row.usd, 300);
  assert.deepEqual(row.range, [150, 400]);
  assert.match(row.how, /commands failed 2\.2% on Sonnet vs 1\.7% on Opus/);
  assert.match(row.caution, /quality is not measured/);
});

test("sparelimit models: prints the split and supports --json; no history exits 1", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-"));
  const run = (h, args) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { encoding: "utf8", env: { ...process.env, HOME: h, SPARELIMIT_HOME: sparelimitHome } });
  assert.equal(run(home, ["models"]).status, 1);
  fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
  fs.copyFileSync(fixture("claude-code-session.jsonl"), path.join(home, ".claude", "projects", "p", "s.jsonl"));
  assert.match(run(home, ["models"]).stdout, /SPARELIMIT MODELS/);
  assert.ok(Array.isArray(JSON.parse(run(home, ["models", "--json"]).stdout).rows));
});

test("digest focus: the biggest habit that has no quality caution, even when the model downshift is bigger", () => {
  const NOW = Date.parse("2026-11-05T12:00:00Z");
  const result = { sessionId: "s", end: new Date(NOW - 86400e3).toISOString(), totalCostUSD: 100, delegation: { verdict: "none", agents: 0, details: [], verbose: [] }, spendBreakdown: { startContextUSD: 0, cacheReadUSD: 0, cacheWriteUSD: 0, outputUSD: 0, inputUSD: 0 }, toolOutputCarryUSD: {}, reads: { total: 0, identicalRepeats: 0, identicalRepeatsCarryUSD: 0 }, earlierReset: { savingUSD: 5, savingLowUSD: 4, savingHighUSD: 6, actualModelUSD: 1 }, breaks: { messages: 0, over60min: 0, resumeUSD: 0, savingUSD: 0, extraVsWarmUSD: 0 }, models: { tasks: { run: { responses: 9, usd: 100, savingUSD: 70, sideUSD: 0 } }, errors: {} }, sidechainUSD: 0, byModelUSD: { opus: 100, sonnet: 0, haiku: 0, other: 0 }, opusHalfToSonnetUSD: 35, findings: [], exposure: { afterFirstWarnUSD: 0, afterFirstStopUSD: 0 }, avoidable: { repeatedCallsUSD: 0, oversizedContextUSD: 0 }, start: new Date(NOW - 2 * 86400e3).toISOString() };
  const d = buildDigest({ events: [], results: [result], now: NOW });
  assert.equal(d.habits.savings[0].id, "model-low-risk", "the model row is the biggest");
  assert.equal(d.focus.id, "reset-early");
});
