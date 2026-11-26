import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowOutlook, FIVE_HOURS, SEVEN_DAYS } from "./rates.mjs";
import { readJson, writeJsonAtomic, stateDir } from "./state.mjs";
import { currentConfigDir, defaultConfigDir, claudeConfigDirs, planScope } from "./accounts.mjs";
import { loadConfig } from "./config.mjs";

/** The log filter for one account: its own config folder (and the Desktop agent sessions, for the default account only). */
export const accountScope = (account = currentConfigDir()) => planScope(account, claudeConfigDirs({ extra: loadConfig().accounts.dirs }));

/**
 * @typedef {{ t: number, cost: number }} CostEvent one response: when and what it cost
 * @typedef {{ at: string, fivePct: number | null, weeklyPct: number | null, weeklyResetMs: number | null, spendFive: number, spendWeek: number | null, account?: string }} CalibrationPoint
 */
const H = 3600e3;
const median = (/** @type {number[]} */ a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/**
 * Rebuild the 5-hour windows from event timestamps: a window opens at the first event after the previous one ended, rounded down to
 * the hour, and lasts 5 hours. (Checked against a real screenshot: events from 11:00 gave 11:00-16:00, as the app showed.)
 */
/** @param {number[]} timestamps */
export function fiveHourWindows(timestamps) {
  const wins = [];
  let end = 0;
  for (const t of [...timestamps].sort((a, b) => a - b)) {
    if (t >= end) {
      const start = Math.floor(t / H) * H;
      wins.push({ start, end: start + FIVE_HOURS });
      end = start + FIVE_HOURS;
    }
  }
  return wins;
}

/** Weekly window that contains `now`, given any one known reset moment (ms). */
/** @param {number} now @param {number} anchorResetMs */
export function weeklyWindow(now, anchorResetMs) {
  const k = Math.floor((now - anchorResetMs) / SEVEN_DAYS) + 1;
  const end = anchorResetMs + k * SEVEN_DAYS;
  return { start: end - SEVEN_DAYS, end };
}

export const spendIn = (/** @type {CostEvent[]} */ events, /** @type {number} */ a, /** @type {number} */ b) => events.reduce((n, e) => (e.t >= a && e.t <= b ? n + e.cost : n), 0);

/** "fri 14:00", "14:00" or an ISO string -> the next such moment after `after` (local time). */
/** @param {string} spec @param {number} [after] */
export function parseResetSpec(spec, after = Date.now()) {
  const iso = Date.parse(spec);
  if (!Number.isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(spec)) return iso;
  const m = String(spec).trim().toLowerCase().match(/^(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+)?(\d{1,2}):(\d{2})\s*(am|pm)?$/);
  if (!m) return null;
  let hh = Number(m[2]);
  if (m[4] === "pm" && hh < 12) hh += 12;
  if (m[4] === "am" && hh === 12) hh = 0;
  const d = new Date(after);
  d.setHours(hh, Number(m[3]), 0, 0);
  const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  if (m[1]) while (d.getDay() !== days.indexOf(m[1]) || d.getTime() <= after) d.setDate(d.getDate() + 1);
  else if (d.getTime() <= after) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export const calibrationPath = () => path.join(stateDir(), "calibration.json");
const loadCalibrationFile = () => readJson(calibrationPath(), { points: [] });
/**
 * The calibration points of one account (I4): a point has the config folder it was taken for; one with none belongs to the default folder
 * (everything recorded before accounts existed). `account` defaults to the current account (CLAUDE_CONFIG_DIR, else the default folder).
 */
export function loadCalibration({ account = currentConfigDir() } = {}) {
  const file = loadCalibrationFile();
  const def = defaultConfigDir();
  const want = path.resolve(account);
  return { ...file, points: (file.points || []).filter((/** @type {CalibrationPoint} */ p) => path.resolve(p.account || def) === want) };
}

/** Record what the app showed (percent used) next to what our logs say was spent in the same windows. */
/** @param {{ at: number, fivePct?: number | null, weeklyPct?: number | null, weeklyResetMs?: number | null, events: CostEvent[], account?: string }} p */
export function addCalibrationPoint({ at, fivePct, weeklyPct, weeklyResetMs, events, account = currentConfigDir() }) {
  const wins = fiveHourWindows(events.map((e) => e.t));
  const w = wins.find((x) => at >= x.start && at < x.end);
  const week = weeklyResetMs ? weeklyWindow(at, weeklyResetMs) : null;
  const point = {
    at: new Date(at).toISOString(),
    fivePct: fivePct ?? null,
    weeklyPct: weeklyPct ?? null,
    weeklyResetMs: weeklyResetMs ?? null,
    spendFive: w ? Number(spendIn(events, w.start, at).toFixed(2)) : 0,
    spendWeek: week ? Number(spendIn(events, week.start, at).toFixed(2)) : null,
    ...(path.resolve(account) === defaultConfigDir() ? {} : { account: path.resolve(account) }) // the default folder's points carry no account, as before
  };
  const cal = loadCalibrationFile();
  cal.points.push(point);
  writeJsonAtomic(calibrationPath(), cal);
  return point;
}

/** Limits in API-equivalent dollars: the median of spend/percent over calibration points (percent >= 15 only). */
export const MIN_CALIBRATION_PCT = 15;
/** @param {CalibrationPoint[]} points */
export function fitLimits(points) {
  const ratio = (/** @type {"spendFive" | "spendWeek"} */ key, /** @type {"fivePct" | "weeklyPct"} */ pctKey) => points.filter((p) => (p[pctKey] ?? 0) >= MIN_CALIBRATION_PCT && (p[key] ?? 0) > 0).map((p) => /** @type {number} */ (p[key]) / (/** @type {number} */ (p[pctKey]) / 100));
  const f = ratio("spendFive", "fivePct");
  const w = ratio("spendWeek", "weeklyPct");
  const spread = (/** @type {number[]} */ a) => (a.length > 1 ? { min: Math.min(...a), max: Math.max(...a) } : null);
  return { fiveHourUSD: median(f), weeklyUSD: median(w), fiveHourPoints: f.length, weeklyPoints: w.length, fiveHourSpread: spread(f), weeklySpread: spread(w) };
}

/** Estimated plan usage right now, from logs only (labelled "estimated": calibrated on a few screenshots, other surfaces not counted). */
/** @param {{ now?: number, events: CostEvent[], calibration?: { points: CalibrationPoint[] } }} p */
export function estimatePlanUsage({ now = Date.now(), events, calibration = loadCalibration() }) {
  const limits = fitLimits(calibration.points);
  const anchor = [...calibration.points].reverse().find((p) => p.weeklyResetMs)?.weeklyResetMs;
  /** @type {{ confidence: string, calibratedOn: number, limits: any, fiveHour: any, weekly: any }} */
  const out = { confidence: "estimated", calibratedOn: calibration.points.length, limits, fiveHour: null, weekly: null };
  const wins = fiveHourWindows(events.map((e) => e.t));
  const w = wins.find((x) => now >= x.start && now < x.end);
  const last30 = (/** @type {number} */ a, /** @type {number} */ b) => spendIn(events, Math.max(a, now - 30 * 60e3), now);
  if (limits.fiveHourUSD) {
    const spent = w ? spendIn(events, w.start, now) : 0;
    const rate = (last30() / 0.5 / limits.fiveHourUSD) * 100;
    const fh = { spentUSD: Number(spent.toFixed(2)), ...windowOutlook({ pct: Math.min(100, (spent / limits.fiveHourUSD) * 100), resetsAt: w ? w.end / 1000 : null }, { ratePctPerHour: rate > 0 ? rate : null, windowMs: FIVE_HOURS, now }) };
    fh.windowStart = w ? new Date(w.start).toISOString() : null;
    fh.resetsAt = w ? w.end / 1000 : null;
    out.fiveHour = fh;
  }
  if (limits.weeklyUSD && anchor) {
    const ww = weeklyWindow(now, anchor);
    const spent = spendIn(events, ww.start, now);
    out.weekly = { spentUSD: Number(spent.toFixed(2)), resetsAt: ww.end / 1000, ...windowOutlook({ pct: Math.min(100, (spent / limits.weeklyUSD) * 100), resetsAt: ww.end / 1000 }, { ratePctPerHour: null, windowMs: SEVEN_DAYS, now }) };
  }
  return out;
}

/** Priced events for the last `days` days, through the incremental cache (first run parses everything, later runs only what changed). */
export async function loadRecentEvents({ days = 8, now = Date.now(), account = currentConfigDir() } = {}) {
  const { refreshPlanCache, cacheEvents } = await import("./plancache.mjs");
  const { cache } = await refreshPlanCache({ now, days });
  return cacheEvents(cache, now - days * 86400e3, accountScope(account));
}
