/**
 * Quota per token class (R5, H4): how many points of the five-hour plan limit does a million tokens of each class use? Each row is one
 * reading of the plan percentage with the tokens the logs show were spent in that window up to the reading. The model is
 *     percent ≈ c_input·input + c_cacheRead·cacheRead + c_cacheWrite·cacheWrite + c_output·output     (tokens in millions, every c ≥ 0)
 * fitted by non-negative least squares (no dependency: coordinate descent on a convex problem, which converges).
 *
 * Fit quality is reported out of sample (leave one out) and against the plain model the planner uses today, "percent = dollars spent ÷ a
 * limit in dollars". A token-class fit only earns its place if it beats that, so both errors are returned side by side. With fewer than
 * QUOTAFIT.minRows readings there is nothing to fit (four coefficients from a handful of rows would just memorise them), and the function
 * says so instead of returning numbers. The readings must be of a window the logs fully cover: usage from chat, Cowork or another machine
 * is in the percentage but not in the tokens, and it biases every coefficient up.
 */
export const QUOTAFIT = { minRows: 20, iterations: 5000 };
export const CLASSES = ["input", "cacheRead", "cacheWrite", "output"];

/** @typedef {{ pct: number, input: number, cacheRead: number, cacheWrite: number, output: number, usd?: number }} QuotaRow tokens in raw counts */

/** Non-negative least squares by coordinate descent. @param {number[][]} X @param {number[]} y @returns {number[]} */
export function nnls(X, y) {
  const n = X.length;
  const k = X[0]?.length || 0;
  const c = new Array(k).fill(0);
  const norm = Array.from({ length: k }, (_, j) => X.reduce((s, r) => s + r[j] * r[j], 0));
  const resid = y.slice();
  for (let it = 0; it < QUOTAFIT.iterations; it++) {
    let moved = 0;
    for (let j = 0; j < k; j++) {
      if (!norm[j]) continue;
      let g = 0;
      for (let i = 0; i < n; i++) g += X[i][j] * resid[i];
      const next = Math.max(0, c[j] + g / norm[j]);
      const d = next - c[j];
      if (d) {
        for (let i = 0; i < n; i++) resid[i] -= X[i][j] * d;
        c[j] = next;
        moved = Math.max(moved, Math.abs(d));
      }
    }
    if (moved < 1e-10) break;
  }
  return c;
}

const toX = (/** @type {QuotaRow} */ r) => [r.input / 1e6, r.cacheRead / 1e6, r.cacheWrite / 1e6, r.output / 1e6];
const median = (/** @type {number[]} */ a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** @param {QuotaRow[]} rows */
export function fitTokenClasses(rows) {
  const usable = rows.filter((r) => Number.isFinite(r.pct) && r.pct > 0 && r.pct < 100);
  if (usable.length < QUOTAFIT.minRows) {
    return { status: "insufficient", rows: usable.length, needRows: QUOTAFIT.minRows, confidence: "not fitted", note: `${usable.length} usable reading${usable.length === 1 ? "" : "s"}; at least ${QUOTAFIT.minRows} are needed before four coefficients mean anything. Readings come from the Desktop app's own history (\`sparelimit plan --app\`) and, once the status line runs, from the quota log.` };
  }
  const X = usable.map(toX);
  const y = usable.map((r) => r.pct);
  const c = nnls(X, y);
  const predict = (/** @type {number[]} */ coef, /** @type {number[]} */ x) => x.reduce((s, v, j) => s + v * coef[j], 0);
  const mean = y.reduce((a, b) => a + b, 0) / y.length;
  const ssTot = y.reduce((s, v) => s + (v - mean) ** 2, 0);
  const ssRes = y.reduce((s, v, i) => s + (v - predict(c, X[i])) ** 2, 0);
  // leave one out, for the token-class model and for the dollar model (percent = spend / limit, the limit being the median of spend / percent)
  const looTok = [];
  const looUsd = [];
  const hasUsd = usable.every((r) => typeof r.usd === "number");
  for (let i = 0; i < usable.length; i++) {
    const Xi = X.filter((_, j) => j !== i);
    const yi = y.filter((_, j) => j !== i);
    looTok.push(Math.abs(predict(nnls(Xi, yi), X[i]) - y[i]));
    if (hasUsd) {
      const limit = median(usable.filter((_, j) => j !== i).map((r) => /** @type {number} */ (r.usd) / (r.pct / 100)));
      looUsd.push(Math.abs(((usable[i].usd || 0) / limit) * 100 - y[i]));
    }
  }
  const coefficients = Object.fromEntries(CLASSES.map((k, j) => [k, Number(c[j].toFixed(4))]));
  return {
    status: "fitted",
    rows: usable.length,
    coefficientsPctPerMillionTokens: coefficients,
    r2: ssTot ? Number((1 - ssRes / ssTot).toFixed(3)) : null,
    medianAbsErrorPoints: Number(median(looTok).toFixed(1)),
    dollarModelMedianAbsErrorPoints: hasUsd ? Number(median(looUsd).toFixed(1)) : null,
    beatsDollarModel: hasUsd ? median(looTok) < median(looUsd) : null,
    confidence: "estimated: out-of-sample (leave one out) against readings of the plan percentage; usage outside the logs biases it up",
    note: "Points of the five-hour limit per million tokens of each class. The error is leave-one-out, in percentage points, next to the dollar model the planner uses today; use the token-class model only if it is smaller."
  };
}
