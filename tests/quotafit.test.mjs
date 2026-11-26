import test from "node:test";
import assert from "node:assert/strict";
import { nnls, fitTokenClasses, QUOTAFIT } from "../src/quotafit.mjs";

// a small deterministic generator, so the test needs no randomness
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

const TRUE = { input: 4, cacheRead: 0.5, cacheWrite: 6, output: 20 }; // points per million tokens
const row = (noise = 0) => {
  const input = rnd() * 2e6, cacheRead = rnd() * 80e6, cacheWrite = rnd() * 2e6, output = rnd() * 1e6;
  const pct = (input * TRUE.input + cacheRead * TRUE.cacheRead + cacheWrite * TRUE.cacheWrite + output * TRUE.output) / 1e6 + (rnd() - 0.5) * noise;
  return { pct, input, cacheRead, cacheWrite, output, usd: (input * 3 + cacheRead * 0.3 + cacheWrite * 3.75 + output * 15) / 1e6 };
};

test("non-negative least squares recovers known coefficients and never goes below zero", () => {
  const X = Array.from({ length: 60 }, () => [rnd() * 2, rnd() * 80, rnd() * 2]);
  const y = X.map((x) => 3 * x[0] + 0.2 * x[1] + 0 * x[2]);
  const c = nnls(X, y);
  assert.ok(Math.abs(c[0] - 3) < 0.01 && Math.abs(c[1] - 0.2) < 0.01 && c[2] < 0.01);
  const neg = nnls([[1], [2], [3]], [-1, -2, -3]);
  assert.deepEqual(neg, [0], "a negative best fit is clamped to zero");
});

test("with too few readings it refuses to fit and says how many are needed", () => {
  const r = fitTokenClasses(Array.from({ length: QUOTAFIT.minRows - 1 }, () => row()));
  assert.equal(r.status, "insufficient");
  assert.equal(r.needRows, QUOTAFIT.minRows);
  assert.equal(r.coefficientsPctPerMillionTokens, undefined);
  assert.equal(fitTokenClasses([]).rows, 0);
});

test("with enough readings it recovers the coefficients, reports out-of-sample error, and compares with the dollar model", () => {
  // keep the readings inside 0 to 100 so none is dropped: scale the true coefficients down
  const rows = Array.from({ length: 40 }, () => { const r = row(1); return { ...r, pct: Math.min(99, Math.max(1, r.pct / 6)) }; });
  const f = fitTokenClasses(rows);
  assert.equal(f.status, "fitted");
  assert.equal(f.rows, 40);
  assert.ok(f.r2 > 0.9, `r2 ${f.r2}`);
  assert.ok(f.medianAbsErrorPoints < 3, `error ${f.medianAbsErrorPoints}`);
  assert.equal(typeof f.dollarModelMedianAbsErrorPoints, "number");
  assert.equal(typeof f.beatsDollarModel, "boolean");
  assert.ok(Object.values(f.coefficientsPctPerMillionTokens).every((v) => v >= 0));
  assert.match(f.confidence, /estimated/);
});

test("readings of 0 or 100 (clamps) are not used", () => {
  const rows = [...Array.from({ length: 25 }, () => ({ ...row(0.5), pct: 20 + rnd() * 30 })), { ...row(), pct: 0 }, { ...row(), pct: 100 }];
  assert.equal(fitTokenClasses(rows).rows, 25);
});

test("the command runs with no history at all and says there is nothing to fit", async () => {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { ROOT } = await import("./helpers.mjs");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-qf-"));
  const r = spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), "quota-fit", "--json"], { encoding: "utf8", env: { ...process.env, HOME: home, SPARELIMIT_HOME: path.join(home, ".sparelimit"), SPARELIMIT_NO_CACHE: "1", CODEX_HOME: path.join(home, "none") } });
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, "insufficient");
  assert.equal(out.readings, 0);
});
