import test from "node:test";
import assert from "node:assert/strict";
import { evaluate } from "../src/policy.mjs";

const NOW = 1_800_000_000_000;

test("empty snapshot allows", () => {
  assert.equal(evaluate({ snapshot: {}, now: NOW }).level, "allow");
});

test("context ladder: warn at 60%, block at 95%", () => {
  assert.equal(evaluate({ snapshot: { contextPct: 59 }, now: NOW }).level, "allow");
  assert.equal(evaluate({ snapshot: { contextPct: 62 }, now: NOW }).level, "warn");
  assert.equal(evaluate({ snapshot: { contextPct: 96 }, now: NOW }).level, "block");
});

test("session budget: warns at $20 by default; a hard block exists only when the user sets one", () => {
  assert.equal(evaluate({ snapshot: { costUsd: 19 }, now: NOW }).level, "allow");
  assert.equal(evaluate({ snapshot: { costUsd: 21 }, now: NOW }).level, "warn");
  assert.equal(evaluate({ snapshot: { costUsd: 500 }, now: NOW }).level, "warn", "no default hard block: it fired on almost every long real session");
  assert.equal(evaluate({ snapshot: { costUsd: 26 }, policy: { budget: { sessionBlockUSD: 25 } }, now: NOW }).level, "block");
});

test("quota: 5-hour window blocks at 95% and names the reset time", () => {
  const r = evaluate({ snapshot: { rateLimits: { fiveHour: { pct: 96, resetsAt: NOW / 1000 + 20 * 60 } } }, now: NOW });
  assert.equal(r.level, "block");
  assert.match(r.findings[0].message, /resets in 20 min/);
});

test("quota projection warns when the window will run out before it resets", () => {
  // 2h elapsed of 5h (resets in 3h), 45% used -> 100% after ~146 more minutes, before the 180 min reset
  const r = evaluate({ snapshot: { rateLimits: { fiveHour: { pct: 45, resetsAt: NOW / 1000 + 3 * 3600 } } }, now: NOW });
  assert.equal(r.level, "warn");
  assert.equal(r.findings[0].rule, "quota.projection");
});

test("quota projection stays quiet when pace is safe", () => {
  const r = evaluate({ snapshot: { rateLimits: { fiveHour: { pct: 35, resetsAt: NOW / 1000 + 1 * 3600 } } }, now: NOW }); // 4h elapsed, 35% -> fine
  assert.equal(r.level, "allow");
});

test("identical-call loop: warn at 4, block at 8", () => {
  assert.equal(evaluate({ snapshot: {}, loop: { count: 3, tool: "Bash" }, now: NOW }).level, "allow");
  assert.equal(evaluate({ snapshot: {}, loop: { count: 4, tool: "Bash" }, now: NOW }).level, "warn");
  assert.equal(evaluate({ snapshot: {}, loop: { count: 8, tool: "Bash" }, now: NOW }).level, "block");
});

test("an active override downgrades blocks to warnings", () => {
  const r = evaluate({ snapshot: { contextPct: 99 }, now: NOW, overrideUntil: NOW + 60_000 });
  assert.equal(r.level, "warn");
  assert.equal(r.overridden, true);
  assert.equal(evaluate({ snapshot: { contextPct: 99 }, now: NOW, overrideUntil: NOW - 1 }).level, "block");
});

test("a null threshold disables a check", () => {
  const r = evaluate({ snapshot: { contextPct: 99 }, policy: { context: { warnPct: null, blockPct: null } }, now: NOW });
  assert.equal(r.level, "allow");
});

test("every warning says what to do next (X5): the rules that did not already carry advice now do, the others are unchanged", async () => {
  const { evaluate, SUGGESTIONS } = await import("../src/policy.mjs");
  const now = Date.parse("2026-11-07T12:00:00Z");
  const r = evaluate({ snapshot: { rateLimits: { fiveHour: { pct: 90, resetsAt: Math.round((now + 3600e3) / 1000) } }, contextPct: 70 }, now });
  const byRule = Object.fromEntries(r.findings.map((f) => [f.rule, f.message]));
  assert.ok(byRule["quota.five_hour"].endsWith(SUGGESTIONS["quota.five_hour"]));
  assert.match(byRule["context.window"], /sparelimit reset/);
  assert.equal(byRule["context.window"].includes(SUGGESTIONS["quota.five_hour"]), false);
  for (const [rule, text] of Object.entries(SUGGESTIONS)) assert.ok(text.length > 20 && rule.includes("."), rule);
});
