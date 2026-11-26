/**
 * Spend-rate and plan-limit maths. Pure functions.
 *  - transcript side: how fast money/tokens were spent (per active hour, last 30 min, peak hour, per turn)
 *  - collector side: how fast the plan quota is being consumed, from the snapshot history
 */
const IDLE_GAP_MS = 10 * 60e3;

/** @param {{ts:string|number|Date, cost:number, tokens:number}[]} points one per API response */
export function spendRate(points, turnCount = 0, windowMin = 30) {
  const pts = points.map((p) => ({ t: new Date(p.ts).getTime(), cost: p.cost, tokens: p.tokens })).filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  if (pts.length === 0) return null;
  const totalCost = pts.reduce((n, p) => n + p.cost, 0);
  const totalTokens = pts.reduce((n, p) => n + p.tokens, 0);

  // Active time: gaps longer than 10 minutes are idle (lunch, overnight), not spending time.
  let activeMs = 0;
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i].t - pts[i - 1].t;
    if (gap <= IDLE_GAP_MS) activeMs += gap;
  }
  activeMs = Math.max(activeMs, 60e3);
  const activeH = activeMs / 3600e3;

  const end = pts[pts.length - 1].t;
  const recent = pts.filter((p) => p.t > end - windowMin * 60e3);
  const recentCost = recent.reduce((n, p) => n + p.cost, 0);
  const recentTokens = recent.reduce((n, p) => n + p.tokens, 0);

  // Peak rolling hour (two-pointer)
  let peak = 0;
  let lo = 0;
  let sum = 0;
  for (let hi = 0; hi < pts.length; hi++) {
    sum += pts[hi].cost;
    while (pts[hi].t - pts[lo].t > 3600e3) sum -= pts[lo++].cost;
    peak = Math.max(peak, sum);
  }

  return {
    activeMinutes: Math.round(activeMs / 60e3),
    costPerActiveHourUSD: Number((totalCost / activeH).toFixed(2)),
    tokensPerActiveHour: Math.round(totalTokens / activeH),
    costPerTurnUSD: turnCount > 0 ? Number((totalCost / turnCount).toFixed(3)) : null,
    recent: { windowMin, costUSD: Number(recentCost.toFixed(3)), tokens: recentTokens, costPerHourUSD: Number(((recentCost / windowMin) * 60).toFixed(2)) },
    peakHourUSD: Number(peak.toFixed(2)),
    firstAt: new Date(pts[0].t).toISOString(),
    lastAt: new Date(end).toISOString()
  };
}

/**
 * Burn rates from the collector's snapshot history ({t, cost, fh, sd}). A drop in a percentage means the
 * quota window reset, so only the samples after the last drop are used.
 */
export function burnFromHistory(history = /** @type {any[]} */ ([]), now = Date.now(), { windowMs = 30 * 60e3, minSpanMs = 5 * 60e3 } = {}) {
  let h = history.filter((s) => s.t >= now - windowMs);
  for (const key of ["fh", "sd"]) {
    for (let i = h.length - 1; i > 0; i--) if (h[i][key] != null && h[i - 1][key] != null && h[i][key] < h[i - 1][key]) { h = h.slice(i); break; }
  }
  if (h.length < 2) return null;
  const a = h[0];
  const b = h[h.length - 1];
  const span = b.t - a.t;
  if (span < minSpanMs) return null;
  const perHour = (/** @type {any} */ x, /** @type {any} */ y) => (x == null || y == null ? null : Number((((y - x) / span) * 3600e3).toFixed(2)));
  return { spanMin: Math.round(span / 60e3), costPerHourUSD: perHour(a.cost, b.cost), fiveHourPctPerHour: perHour(a.fh, b.fh), sevenDayPctPerHour: perHour(a.sd, b.sd) };
}

/** Human summary of one quota window: where it stands, how fast it burns, and whether it lasts until reset. */
/**
 * @param {{ pct: number | null, resetsAt?: number | null }} window
 * @param {{ ratePctPerHour?: number | null, windowMs: number, now?: number }} opts
 */
export function windowOutlook({ pct, resetsAt }, { ratePctPerHour = null, windowMs, now = Date.now() }) {
  if (pct == null) return null;
  const resetMs = resetsAt ? Math.max(0, resetsAt * 1000 - now) : null;
  let rate = ratePctPerHour;
  let basis = "recent";
  if ((rate == null || rate <= 0) && resetMs != null) {
    const elapsed = windowMs - resetMs;
    if (elapsed > 10 * 60e3) {
      rate = (pct / elapsed) * 3600e3; // window average
      basis = "window average";
    }
  }
  /** @type {any} */
  const out = { pct, resetsInMin: resetMs != null ? Math.round(resetMs / 60e3) : null, ratePctPerHour: rate != null ? Number(rate.toFixed(1)) : null, basis, minutesToLimit: null, lastsUntilReset: null };
  if (rate != null && rate > 0) {
    out.minutesToLimit = Math.round(((100 - pct) / rate) * 60);
    if (resetMs != null) out.lastsUntilReset = out.minutesToLimit * 60e3 >= resetMs;
  }
  return out;
}

export const FIVE_HOURS = 5 * 3600e3;
export const SEVEN_DAYS = 7 * 24 * 3600e3;
