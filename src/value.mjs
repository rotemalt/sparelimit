/**
 * Value (advance versus invoice): what you used over a period at list price, set against what your plan costs, and what a HYBRID price
 * (a fixed base that includes an allowance, plus pay-per-cost above it) would charge for the same usage. Nobody has published such terms, so
 * every hybrid figure is a labelled scenario from numbers you pass in, never a prediction. Dollars are API-equivalent at list price (derived).
 */
const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;
const WEEKS_PER_MONTH = 52 / 12;

/**
 * @param {{ usedUSD: number, days: number, planUSD: number, weeklyLimitUSD?: number | null, allowanceUSD?: number | null, rate?: number }} p
 *   usedUSD: list-price spend in the last `days` days; planUSD: what you pay per month; weeklyLimitUSD: your fitted weekly limit (quota fit);
 *   allowanceUSD: the monthly allowance to assume for the hybrid base (default: the fitted weekly limit x 52/12); rate: overage price as a multiple of list (default 1)
 */
export function buildValue({ usedUSD, days, planUSD, weeklyLimitUSD = null, allowanceUSD = null, rate = 1 }) {
  const monthlyUsedUSD = (usedUSD * 30) / Math.max(1, days);
  const allowance = allowanceUSD ?? (weeklyLimitUSD ? weeklyLimitUSD * WEEKS_PER_MONTH : null);
  const hybrid = allowance == null ? null : { baseUSD: r2(planUSD), allowanceUSD: r2(allowance), overageUSD: r2(Math.max(0, monthlyUsedUSD - allowance) * rate), totalUSD: r2(planUSD + Math.max(0, monthlyUsedUSD - allowance) * rate), rate };
  return {
    days,
    planUSD: r2(planUSD),
    usedUSD: r2(usedUSD),
    monthlyUsedUSD: r2(monthlyUsedUSD),
    valueMultiple: planUSD > 0 ? r2(monthlyUsedUSD / planUSD) : null,
    payPerUseUSD: r2(monthlyUsedUSD),
    hybrid,
    allowanceSource: allowanceUSD != null ? "passed in" : weeklyLimitUSD ? "your fitted weekly limit x 52/12 (quota fit)" : null,
    confidence: "derived",
    note: "Used is API-equivalent at list price (derived), scaled to 30 days. The hybrid line is a scenario, not a quote: it assumes your plan price becomes a base that includes the allowance shown, with anything above billed at list price x the rate shown. No such terms are announced; change them with --allowance= and --rate=."
  };
}
