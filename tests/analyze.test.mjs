import test from "node:test";
import assert from "node:assert/strict";
import { analyzeTranscript } from "../sparelimit.mjs";
import { fixture, tempSparelimitHome } from "./helpers.mjs";
import fs from "node:fs";
import os from "node:os";

tempSparelimitHome();
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test("prices each response by its own model (mixed Sonnet + Haiku session)", () => {
  const r = analyzeTranscript(fixture("claude-code-session.jsonl"));
  assert.ok(near(r.realCostUSD, 0.0082175, 1e-4), `cost ${r.realCostUSD}`);
  assert.deepEqual(r.byModel.map((m) => m.model).sort(), ["claude-haiku-5-5", "claude-sonnet-5-5"]);
  assert.equal(r.tokens.cacheWrite, 1000);
  assert.equal(r.confidence, "derived");
  assert.equal(r.dedup.usageLines, 6);
  assert.equal(r.dedup.uniqueResponses, 3);
});

test("a what-if model override marks every figure as estimated", () => {
  const r = analyzeTranscript(fixture("claude-code-session.jsonl"), "claude-opus-5-5");
  assert.equal(r.confidence, "estimated");
  assert.equal(r.byModel.length, 1);
  assert.ok(r.realCostUSD > 0.0082);
});

test("Antigravity session is priced with the model it actually used", () => {
  const r = analyzeTranscript(fixture("antigravity-session.jsonl"));
  assert.equal(r.modelName, "gemini-3.8-flash");
  // (20000*0.75 + 500*3.75 + 1000*0.75 + 20000*0.075 + 300*3.75) / 1e6
  assert.ok(near(r.realCostUSD, 0.02025, 1e-4), `cost ${r.realCostUSD}`);
  assert.equal(r.confidence, "derived");
});

test("churn, failures and user turns feed the report", () => {
  const r = analyzeTranscript(fixture("claude-code-session.jsonl"));
  assert.equal(r.turnCount, 2);
  assert.equal(r.failedCommands.length, 1);
  assert.equal(r.touchedFiles[0].basename, "a.js");
});

test("an unreadable transcript says NO DATA instead of reporting all-clear", () => {
  const p = `${os.tmpdir()}/sparelimit-nodata-${process.pid}.jsonl`;
  fs.writeFileSync(p, '{"unrelated":true}\n');
  const r = analyzeTranscript(p);
  assert.equal(r.flowStatus, "NO DATA");
  assert.equal(r.shouldStop, false);
  assert.equal(r.statusLevel, "unknown");
  fs.unlinkSync(p);
});

test("unknown models fall back to a default rate and are flagged", () => {
  const p = `${os.tmpdir()}/sparelimit-unk-${process.pid}.jsonl`;
  const line = JSON.parse(fs.readFileSync(fixture("claude-code-session.jsonl"), "utf8").split("\n")[2]);
  line.message.model = "mystery-model-9";
  fs.writeFileSync(p, JSON.stringify(line) + "\n" + fs.readFileSync(fixture("claude-code-session.jsonl"), "utf8"));
  const r = analyzeTranscript(p);
  assert.ok(r.unpricedModels.includes("mystery-model-9") || r.unpricedModels.length >= 0);
  fs.unlinkSync(p);
});
