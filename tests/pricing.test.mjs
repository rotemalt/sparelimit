import test from "node:test";
import assert from "node:assert/strict";
import { loadPricing, resolveModel, ratesFor, costUSD } from "../src/pricing.mjs";
import { tempSparelimitHome } from "./helpers.mjs";

tempSparelimitHome();
const pricing = loadPricing();

test("resolves model aliases from different agents", () => {
  assert.equal(resolveModel(pricing, "claude-sonnet-5-5").key, "claude-sonnet-5-5");
  assert.equal(resolveModel(pricing, "claude-opus-5-5[1m]").key, "claude-opus-5-5");
  assert.equal(resolveModel(pricing, "Gemini 3.8 Flash (High)").key, "gemini-3.8-flash");
  assert.equal(resolveModel(pricing, "claude-sonnet-4-5-20991231").key, "claude-sonnet-4-5");
  assert.equal(resolveModel(pricing, "Claude Sonnet 5.5 (Medium)").key, "claude-sonnet-5-5");
  assert.equal(resolveModel(pricing, "Gemini 3.8 Flash (High)").key, "gemini-3.8-flash");
  assert.equal(resolveModel(pricing, "no-such-model"), null);
  assert.equal(resolveModel(pricing, null), null);
});

test("Claude rates match Anthropic's published table (per 1M tokens)", () => {
  const r = ratesFor(pricing, "claude-sonnet-5-5");
  assert.deepEqual([r.input, r.cacheWrite5m, r.cacheWrite1h, r.cacheRead, r.output], [2, 2.5, 4, 0.1, 10]);
  const o = ratesFor(pricing, "claude-opus-5-5");
  assert.deepEqual([o.input, o.cacheRead, o.output], [4, 0.2, 20]);
});

test("Gemini 3.8 Flash doubles on 2027-01-01 (effective-dated override)", () => {
  const before = ratesFor(pricing, "gemini-3.8-flash", { at: "2026-11-05T00:00:00Z" });
  const after = ratesFor(pricing, "gemini-3.8-flash", { at: "2027-01-02T00:00:00Z" });
  assert.deepEqual([before.input, before.cacheRead, before.output], [0.75, 0.075, 3.75]);
  assert.deepEqual([after.input, after.cacheRead, after.output], [1.5, 0.15, 7.5]);
});

test("Haiku 5.5 bills the whole prompt at the higher tier above 100k tokens", () => {
  assert.equal(ratesFor(pricing, "claude-haiku-5-5", { promptTokens: 50_000 }).input, 0.1);
  const hi = ratesFor(pricing, "claude-haiku-5-5", { promptTokens: 150_000 });
  assert.deepEqual([hi.input, hi.cacheRead, hi.output], [0.5, 0.05, 2.5]);
});

test("costUSD sums every token class", () => {
  const r = ratesFor(pricing, "claude-sonnet-5-5");
  const c = costUSD(r, { input: 10, cacheRead: 5000, cacheWrite5m: 0, cacheWrite1h: 1000, output: 200 });
  assert.ok(Math.abs(c - 0.00652) < 1e-9);
});

test("providers without a cache-write price bill writes as normal input", () => {
  const r = ratesFor(pricing, "gemini-3.8-flash", { at: "2026-11-05" });
  assert.equal(r.cacheWrite5m, r.input);
});

test("pricing health: age of the snapshot, and models you used that are past or near their deprecation date", async () => {
  const { pricingHealth } = await import("../src/pricing.mjs");
  const now = Date.parse("2026-11-06T00:00:00Z");
  const p = { generatedAt: "2026-09-01", models: { "claude-old": { deprecationDate: "2026-11-30" }, "claude-gone": { deprecationDate: "2026-10-01" }, "claude-far": { deprecationDate: "2027-12-01" }, "claude-none": {} } };
  const h = pricingHealth(p, { used: ["claude-old", "claude-gone", "claude-far", "claude-none", "claude-old", "unknown-model"], now });
  assert.equal(h.ageDays, 66);
  assert.equal(h.stale, true);
  assert.deepEqual(h.deprecated.map((d) => [d.model, d.daysLeft, d.past]), [["claude-gone", -36, true], ["claude-old", 24, false]], "past first, then soonest; far, none and unknown are left out, repeats once");
  assert.equal(pricingHealth({ generatedAt: "2026-11-01", models: {} }, { now }).stale, false);
  assert.equal(pricingHealth({ generatedAt: "unknown", models: {} }, { now }).stale, true);
});
