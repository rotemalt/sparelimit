import path from "node:path";
import { priceEvent } from "./analyze.mjs";
import { windowOutlook, FIVE_HOURS, SEVEN_DAYS } from "./rates.mjs";

/**
 * What Codex sessions cost (A7): spend, tokens by class and spend by model and by day, from the parsed sessions. Tokens are exact as the
 * log reports them; dollars are API-equivalent at list price (derived), and a model that is not in the price list is priced at a default
 * and counted separately (estimated). The coaching views (reset timing, cold-cache returns, model advice) are NOT applied to Codex: their
 * rules are Claude's (cache lifetime, model families), and applying them here would produce numbers with nothing behind them.
 */
const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;

/**
 * @param {any[]} sessions parsed Codex sessions
 * @param {{ pricing?: any, now?: number }} [opts]
 */
export function summarizeCodex(sessions, { pricing, now = Date.now() } = {}) {
  const byModel = new Map();
  const byDay = new Map();
  const rows = [];
  const tok = { input: 0, cacheRead: 0, output: 0 };
  let total = 0;
  let estimated = 0;
  let responses = 0;
  let subagents = 0;
  let newest = null;
  const samples = [];
  for (const s of sessions) {
    if (!s.events.length) continue;
    if (s.subagent) subagents += 1;
    for (const x of s.raw?.rateSamples || []) samples.push(x);
    const rl = s.raw?.rateLimits;
    if (rl && s.raw.rateLimitsAt && (!newest || s.raw.rateLimitsAt > newest.at)) newest = { at: s.raw.rateLimitsAt, rl };
    let cost = 0;
    for (const ev of s.events) {
      const p = priceEvent(ev, pricing);
      cost += p.cost;
      total += p.cost;
      if (p.unpriced) estimated += p.cost;
      responses += 1;
      tok.input += ev.usage.input;
      tok.cacheRead += ev.usage.cacheRead;
      tok.output += ev.usage.output;
      const m = byModel.get(ev.model || "unknown") || { model: ev.model || "unknown", responses: 0, usd: 0, priced: !p.unpriced };
      m.responses += 1;
      m.usd += p.cost;
      byModel.set(m.model, m);
      const day = new Date(ev.ts).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + p.cost);
    }
    rows.push({ id: s.sessionId, threadId: s.threadId, parentId: s.parentId, project: s.projectDir ? path.basename(s.projectDir) : null, subagent: s.subagent, start: s.events[0].ts, responses: s.events.length, usd: r2(cost) });
  }
  const all = tok.input + tok.cacheRead + tok.output;
  const since = new Date(now - 14 * 86400e3).toISOString().slice(0, 10);

  // Group each subagent under the conversation that started it (through parent_thread_id, up to ten levels; a parent that is not in the
  // logs, or a loop, leaves the session as a conversation of its own).
  const byThread = new Map(rows.filter((r) => r.threadId).map((r) => [r.threadId, r]));
  const rootOf = (/** @type {any} */ r) => {
    let cur = r;
    for (let i = 0; i < 10 && cur.parentId && byThread.has(cur.parentId) && byThread.get(cur.parentId) !== r; i++) cur = byThread.get(cur.parentId);
    return cur.parentId && byThread.has(cur.parentId) ? r : cur;
  };
  const families = new Map();
  for (const r of rows) {
    const root = r.parentId ? rootOf(r) : r;
    const f = families.get(root.id) || { id: root.id, project: root.project, start: root.start, ownUSD: 0, subUSD: 0, subagents: 0, subCosts: [] };
    if (root === r) {
      f.ownUSD += r.usd;
      f.project = r.project;
      f.start = r.start;
    } else {
      f.subUSD += r.usd;
      f.subagents += 1;
      f.subCosts.push(r.usd);
    }
    families.set(root.id, f);
  }
  const conv = [...families.values()].map((f) => ({ id: f.id, project: f.project, start: f.start, ownUSD: r2(f.ownUSD), subagentUSD: r2(f.subUSD), subagents: f.subagents, totalUSD: r2(f.ownUSD + f.subUSD) }));
  const subCosts = [...families.values()].flatMap((f) => f.subCosts).sort((a, b) => a - b);
  const subTotal = subCosts.reduce((n, x) => n + x, 0);
  const widest = [...conv].sort((a, b) => b.subagents - a.subagents)[0];
  return {
    sessions: rows.length,
    subagentSessions: subagents,
    responses,
    totalUSD: r2(total),
    unpricedUSD: r2(estimated),
    tokens: { ...tok, total: all, cacheReadShare: all ? Math.round((tok.cacheRead / all) * 1000) / 10 : 0 },
    byModel: [...byModel.values()].map((m) => ({ ...m, usd: r2(m.usd) })).sort((a, b) => b.usd - a.usd),
    last14Days: [...byDay].filter(([d]) => d >= since).sort().map(([day, usd]) => ({ day, usd: r2(usd) })),
    conversations: conv.length,
    fanOut: {
      subagentSessions: subCosts.length,
      subagentUSD: r2(subTotal),
      shareOfSpend: total ? Math.round((subTotal / total) * 1000) / 10 : 0,
      medianSubagentUSD: subCosts.length ? r2(subCosts[Math.floor(subCosts.length / 2)]) : 0,
      widest: widest && widest.subagents ? { project: widest.project, subagents: widest.subagents, subagentUSD: widest.subagentUSD } : null
    },
    top: conv.sort((a, b) => b.totalUSD - a.totalUSD).slice(0, 5),
    planLimits: planLimitsFrom(samples, newest, now),
    confidence: estimated > 0 ? "derived, with the models missing from the price list estimated" : "derived"
  };
}

/**
 * Percent per hour over the last `windowMs`, for one limit window (readings that share a reset time). Within a window the used share can only
 * rise, so a reading below an earlier one is a different session's older snapshot of the same account figure, not a reset: the pace is taken
 * from the running maximum. Null with fewer than two readings or less than five minutes between them.
 */
export function codexPace(/** @type {any} */ samples, /** @type {any} */ key, /** @type {any} */ resetKey, /** @type {number} */ now, { windowMs = 30 * 60e3, minSpanMs = 5 * 60e3 } = {}) {
  const last = samples[samples.length - 1];
  if (!last || last[key] == null) return null;
  const h = samples.filter((/** @type {any} */ x) => x[resetKey] === last[resetKey] && x[key] != null && x.t >= now - windowMs);
  if (h.length < 2) return null;
  let max = -1;
  const env = h.map((/** @type {any} */ x) => ({ t: x.t, v: (max = Math.max(max, x[key])) }));
  const span = env[env.length - 1].t - env[0].t;
  if (span < minSpanMs) return null;
  return Number((((env[env.length - 1].v - env[0].v) / span) * 3600e3).toFixed(2));
}

/**
 * The account's plan limits as Codex last reported them, and where they are heading. The percentages are account-wide, so readings from
 * every session are merged in time order. A forecast needs a window that has not reset since the last reading. The 5-hour pace is the last 30
 * minutes of that window (see codexPace); with no recent pace, and always for the week, it is the window average, which is not used before a fifth
 * of the window has passed (a burst at the start of a week says nothing about the week).
 */
function planLimitsFrom(/** @type {any} */ samples, /** @type {any} */ newest, /** @type {number} */ now) {
  if (!newest && !samples.length) return null;
  const sorted = [...samples].sort((a, b) => a.t - b.t);
  const last = sorted[sorted.length - 1];
  const at = last ? new Date(last.t).toISOString() : newest.at;
  const fiveHourPct = last ? last.fh : newest.rl.primary?.window_minutes === 300 ? newest.rl.primary.used_percent ?? null : null;
  const weeklyPct = last ? last.sd : newest.rl.secondary?.window_minutes === 10080 ? newest.rl.secondary.used_percent ?? null : null;
  /** @type {{ at: string, fiveHourPct: number | null, weeklyPct: number | null, confidence: string, forecast: any }} */
  const out = { at, fiveHourPct, weeklyPct, confidence: "exact: reported by Codex in its own log", forecast: null };
  if (!last) return out;
  const ageMin = Math.max(0, Math.round((now - last.t) / 60e3));
  const fresh = ageMin <= 30;
  const one = (/** @type {any} */ pct, /** @type {any} */ resetsAt, /** @type {any} */ rate, /** @type {any} */ windowMs) => {
    if (pct == null || !resetsAt || resetsAt * 1000 <= now) return null;
    const o = windowOutlook({ pct, resetsAt }, { ratePctPerHour: rate, windowMs, now });
    if (o && o.basis === "window average" && windowMs - (o.resetsInMin ?? 0) * 60e3 < 0.2 * windowMs) return { ...o, ratePctPerHour: null, minutesToLimit: null, lastsUntilReset: null, basis: "too early in the window to project" };
    return o;
  };
  const fiveHour = one(last.fh, last.fhReset, fresh ? codexPace(sorted, "fh", "fhReset", now) : null, FIVE_HOURS);
  const weekly = one(last.sd, last.sdReset, null, SEVEN_DAYS); // a week is judged by its average: a 30-minute burst says nothing about it
  const reset = (last.fhReset && last.fhReset * 1000 <= now) || (last.sdReset && last.sdReset * 1000 <= now);
  out.forecast = { ageMin, fiveHour, weekly, windowResetSinceReading: !!reset, confidence: "estimated: the pace of the last 30 minutes (or the window average) continued" };
  return out;
}
