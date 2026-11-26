/**
 * Data behind the local dashboard (X6/R3): spend history, plan-limit gauges and the feed of what Sparelimit said and what came of it.
 * Pure functions: the dashboard server passes in events, the plan estimate, the audit log and the ledger. Labels follow the rest of
 * Sparelimit: spend history is derived from the logs; plan percentages are estimated (calibrated from the user's own screenshots).
 */
export const HOUR = 3600e3;
export const DAY = 24 * HOUR;
/** @typedef {{ t: number, cost: number }} CostEvent */
const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;
const r1 = (/** @type {number} */ n) => Math.round(n * 10) / 10;

const localHourStart = (/** @type {number} */ t) => {
  const d = new Date(t);
  d.setMinutes(0, 0, 0);
  return d.getTime();
};

/** Spend per clock hour for the last `hours` hours, oldest first; the last bucket is the current, partly elapsed hour. */
/** @param {CostEvent[]} events @param {number} now */
export function hourlyBuckets(events, now, hours = 24) {
  const end = localHourStart(now) + HOUR;
  const start = end - hours * HOUR;
  const out = Array.from({ length: hours }, (_, i) => ({ start: start + i * HOUR, usd: 0 }));
  for (const e of events) if (e.t >= start && e.t < end) out[Math.floor((e.t - start) / HOUR)].usd += e.cost;
  return out.map((b) => ({ start: b.start, usd: r2(b.usd), partial: b.start + HOUR > now }));
}

/** Spend per local calendar day for the last `days` days, oldest first; the last bucket is today so far. */
/** @param {CostEvent[]} events @param {number} now */
export function dailyBuckets(events, now, days = 7) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  /** @type {number[]} */
  const starts = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i); // setDate keeps local midnight across daylight-saving changes
    starts.push(d.getTime());
  }
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const b = starts.map((start, i) => ({ start, end: i + 1 < days ? starts[i + 1] : tomorrow.getTime(), usd: 0 }));
  for (const e of events) {
    const x = b.find((y) => e.t >= y.start && e.t < y.end);
    if (x) x.usd += e.cost;
  }
  return b.map((x) => ({ start: x.start, usd: r2(x.usd), partial: x.end > now }));
}

/** Spend rate over the last 30 minutes, in dollars per hour, beside the busiest hour of the last 24. */
/** @param {CostEvent[]} events @param {number} now */
export function spendRate(events, now) {
  const recent = events.filter((e) => e.t > now - 30 * 60e3 && e.t <= now).reduce((n, e) => n + e.cost, 0);
  const peak = Math.max(0, ...hourlyBuckets(events, now).map((b) => b.usd));
  return { perHourUSD: r2(recent * 2), windowMin: 30, peakHourUSD: r2(peak), confidence: "derived" };
}

/** @param {any} win @param {number | null | undefined} limitUSD */
function gauge(win, limitUSD) {
  if (!win) return null;
  return {
    pct: r1(win.pct),
    spentUSD: win.spentUSD,
    limitUSD: limitUSD ? r2(limitUSD) : null,
    resetsAt: win.resetsAt ? win.resetsAt * 1000 : null,
    resetsInMin: win.resetsInMin ?? null,
    ratePctPerHour: win.ratePctPerHour ?? null,
    basis: win.basis ?? null,
    minutesToLimit: win.minutesToLimit ?? null,
    lastsUntilReset: win.lastsUntilReset ?? null
  };
}

/**
 * Pre-flight estimate (X10): what share of the five-hour limit one message costs, from its dollar cost and the calibrated limit in dollars.
 * This is the dollar model the planner uses everywhere else ("percent = dollars ÷ limit"), so it inherits its error, which the owner's
 * readings show can be large (see \`sparelimit quota-fit\`); it is labelled estimated, and the accuracy target of the plan (within 25%) was not
 * checked. Null when there is no calibrated limit or no cost.
 * @param {number | null | undefined} costUSD @param {number | null | undefined} limitUSD
 */
export function preflightPct(costUSD, limitUSD) {
  if (!(typeof costUSD === "number" && costUSD > 0) || !(typeof limitUSD === "number" && limitUSD > 0)) return null;
  return Math.round((costUSD / limitUSD) * 1000) / 10;
}

/** Everything the overview needs, from cached events and the plan estimate (estimatePlanUsage). */
/** @param {{ events: CostEvent[], estimate: any, now: number }} p */
export function overview({ events, estimate, now }) {
  const limits = estimate?.limits || {};
  return {
    now,
    calibrated: !!(limits.fiveHourUSD || limits.weeklyUSD),
    plan: { fiveHour: gauge(estimate?.fiveHour, limits.fiveHourUSD), weekly: gauge(estimate?.weekly, limits.weeklyUSD), calibratedOn: estimate?.calibratedOn ?? 0, fiveHourLimitUSD: limits.fiveHourUSD ?? null, confidence: "estimated" },
    history: { hourly: hourlyBuckets(events, now), daily: dailyBuckets(events, now), confidence: "derived" },
    rate: spendRate(events, now)
  };
}

const familyOf = (/** @type {string} */ rule) => (/^quota\./.test(rule) ? "quota" : rule === "context.reset" || rule === "context.window" ? "reset" : rule === "cache.cold" ? "cold" : null);
const GAP = 30 * 60e3;

/**
 * What Sparelimit said recently, newest first, and what came of it. Repeats of the same rule in the same session within 30 minutes are one
 * item (with a count). Where the ledger judged the same alert, its verdict is attached: counted, ignored, pending, and so on.
 */
/** @param {any[]} auditRows @param {any[]} [ledgerEntries] */
export function interventionFeed(auditRows, ledgerEntries = [], now = Date.now(), days = 7) {
  const rows = auditRows.filter((r) => (r.kind === "finding" || r.kind === "coach") && Number.isFinite(Date.parse(r.t))).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const open = new Map();
  const items = [];
  for (const r of rows) {
    const ms = Date.parse(r.t);
    const key = `${r.rule}|${r.sessionId}`;
    const cur = open.get(key);
    if (cur && ms - cur.lastMs <= GAP) {
      cur.lastMs = ms;
      cur.count += 1;
      continue;
    }
    const item = { t: ms, lastMs: ms, rule: r.rule, kind: r.kind === "coach" ? "nudge" : r.level === "block" ? "stop" : "warning", message: r.message || "", sessionId: r.sessionId || null, count: 1, family: familyOf(r.rule) };
    open.set(key, item);
    items.push(item);
  }
  return items
    .filter((i) => i.t > now - days * DAY)
    .map(({ lastMs, family, ...i }) => {
      const e = family && ledgerEntries.filter((x) => x.family === family && (x.rules || []).includes(i.rule) && i.t >= Date.parse(x.at) - 60e3 && i.t <= Date.parse(x.at) + 60 * 60e3).sort((a, b) => Math.abs(Date.parse(a.at) - i.t) - Math.abs(Date.parse(b.at) - i.t))[0];
      return { ...i, at: new Date(i.t).toISOString(), outcome: e ? { status: e.status, savingUSD: e.savingUSD ?? null, predictedUSD: e.predictedUSD ?? null, note: e.note || e.how || "" } : null };
    })
    .sort((a, b) => b.t - a.t);
}
