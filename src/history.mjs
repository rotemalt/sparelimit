import path from "node:path";
import { buildWhy } from "./why.mjs";
import { projectLabel } from "./sources.mjs";

/**
 * History (D4): spend by day and by week, by project, and the causes that cost the most across sessions. Built from replay results only,
 * so every figure traces to `sparelimit replay`. Dollars are API-equivalent at list price (derived). The causes OVERLAP (see `sparelimit why`), so each
 * is shown with its own total and nothing is summed across them.
 * Days and weeks are the local calendar; a week starts on Monday.
 */
const DAY = 86400e3;
const pad = (/** @type {number} */ n) => String(n).padStart(2, "0");
const dayKey = (/** @type {number} */ t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const mondayKey = (/** @type {number} */ t) => {
  const d = new Date(t);
  return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime());
};
const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;

/**
 * @param {any[]} results replay results with timelines
 * @param {{ now?: number, days?: number }} [opts]
 */
export function buildHistory(results, { now = Date.now(), days = 30 } = {}) {
  const since = now - days * DAY;
  /** @type {Map<string, number>} */
  const daily = new Map();
  /** @type {Map<string, number>} */
  const weekly = new Map();
  /** @type {Map<string, { project: string, usd: number, sessions: number }>} */
  const projects = new Map();
  /** @type {Map<string, { id: string, title: string, kind: string, confidence: string, usd: number, sessions: number }>} */
  const causes = new Map();
  let total = 0;
  let sessions = 0;
  for (const r of results) {
    const inRange = (r.timeline || []).filter((/** @type {{ t: number }} */ e) => e.t >= since && e.t <= now);
    if (!inRange.length) continue;
    sessions += 1;
    const spent = inRange.reduce((/** @type {number} */ n, /** @type {{ cost: number }} */ e) => n + e.cost, 0);
    total += spent;
    for (const e of inRange) {
      daily.set(dayKey(e.t), (daily.get(dayKey(e.t)) || 0) + e.cost);
      weekly.set(mondayKey(e.t), (weekly.get(mondayKey(e.t)) || 0) + e.cost);
    }
    const name = projectLabel(path.basename(String(r.project || "")));
    const p = projects.get(name) || { project: name, usd: 0, sessions: 0 };
    p.usd += spent;
    p.sessions += 1;
    projects.set(name, p);
    // a cause is counted from sessions that spent in range, in full: causes are per session, not per day
    for (const c of buildWhy(r).causes) {
      const cur = causes.get(c.id) || { id: c.id, title: c.title, kind: c.kind, confidence: c.confidence, usd: 0, sessions: 0 };
      cur.usd += c.usd;
      cur.sessions += 1;
      causes.set(c.id, cur);
    }
  }
  const byKey = (/** @type {Map<string, number>} */ m, /** @type {string} */ k) => [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([key, usd]) => ({ [k]: key, usd: r2(usd) }));
  return {
    days,
    totalUSD: r2(total),
    sessions,
    daily: byKey(daily, "date"),
    weekly: byKey(weekly, "weekStart"),
    projects: [...projects.values()].map((p) => ({ ...p, usd: r2(p.usd) })).sort((a, b) => b.usd - a.usd).slice(0, 10),
    causes: [...causes.values()].map((c) => ({ ...c, usd: r2(c.usd) })).sort((a, b) => b.usd - a.usd),
    confidence: "derived",
    note: "Dollars are API-equivalent at list price (derived). Days are the local calendar and weeks start on Monday. The causes overlap, so each has its own total and nothing is summed across them; a cause is counted for every session that spent in the period, in full."
  };
}
