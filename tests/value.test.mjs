import test from "node:test";
import assert from "node:assert/strict";
import { buildValue } from "../src/value.mjs";

test("used is scaled to 30 days and compared with the plan price", () => {
  const v = buildValue({ usedUSD: 494, days: 15, planUSD: 100 });
  assert.equal(v.monthlyUsedUSD, 988);
  assert.equal(v.valueMultiple, 9.88);
  assert.equal(v.payPerUseUSD, 988);
  assert.equal(v.hybrid, null);
  assert.equal(v.confidence, "derived");
});

test("the hybrid scenario bills only the part above the allowance, at the given rate", () => {
  const v = buildValue({ usedUSD: 1000, days: 30, planUSD: 200, allowanceUSD: 600, rate: 0.5 });
  assert.deepEqual(v.hybrid, { baseUSD: 200, allowanceUSD: 600, overageUSD: 200, totalUSD: 400, rate: 0.5 });
  assert.equal(v.allowanceSource, "passed in");
  const under = buildValue({ usedUSD: 100, days: 30, planUSD: 200, allowanceUSD: 600 });
  assert.equal(under.hybrid?.totalUSD, 200);
});

test("without a passed allowance it comes from the fitted weekly limit", () => {
  const v = buildValue({ usedUSD: 1000, days: 30, planUSD: 100, weeklyLimitUSD: 252 });
  assert.equal(v.hybrid?.allowanceUSD, 1092);
  assert.match(v.allowanceSource, /quota fit/);
  assert.match(v.note, /not a quote/);
});
