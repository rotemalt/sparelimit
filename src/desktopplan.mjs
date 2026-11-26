import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fiveHourWindows, spendIn, MIN_CALIBRATION_PCT } from "./planestimate.mjs";

/**
 * X16: the Claude Desktop app keeps its own record of the plan-usage percentages it showed, in `plan-usage-history.json` in its data
 * folder. Samples are {t, u: {fh, sd}}: the five-hour and seven-day percent used. Sparelimit reads the file and nothing else of the app's,
 * only on this machine and only to read. The file's format is the app's own and undocumented (version 2 when written), so the reader is
 * strict: anything that does not look right is ignored, never guessed at. The organisation id in each sample is dropped on read.
 *
 * What the samples are: the app's own figures (exact as displayed), but sparse: a sample is written when the app fetches usage, so there
 * are gaps of days, and the file can be stale. Not a live feed. The percentages are clamped at 0 and 100, so 100 only says "at the limit".
 * The weekly figure is not used to calibrate: the samples show the weekly figure resetting on dates that are not a fixed 7 days apart,
 * so no reset moment can be anchored from them.
 */
export const DESKTOP = { version: 2, maxSamples: 5000, usableMax: 95 };

export function desktopPlanPath({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude", "plan-usage-history.json");
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude", "plan-usage-history.json");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude", "plan-usage-history.json");
}

const pctOk = (/** @type {any} */ x) => typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 100;

/** The samples in the file, oldest first: [{ t, fiveHourPct, weeklyPct }]; [] when the file is missing or not in the expected shape. */
export function readDesktopPlanSamples({ file = desktopPlanPath() } = {}) {
  let j;
  try {
    if (fs.statSync(file).size > 5e6) return [];
    j = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!j || j.version !== DESKTOP.version || !Array.isArray(j.samples)) return [];
  const out = [];
  for (const s of j.samples.slice(-DESKTOP.maxSamples)) {
    const t = s?.t;
    if (typeof t !== "number" || !Number.isFinite(t) || t < 1.5e12 || t > Date.now() + 864e5) continue; // after 2017, not in the future
    const fh = s?.u?.fh;
    const sd = s?.u?.sd;
    if (!pctOk(fh) && !pctOk(sd)) continue;
    out.push({ t, fiveHourPct: pctOk(fh) ? fh : null, weeklyPct: pctOk(sd) ? sd : null });
  }
  return out.sort((a, b) => a.t - b.t);
}

const median = (/** @type {number[]} */ a) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/** The samples that can calibrate the five-hour limit: far enough from 0 to divide by, below the clamp at 100. */
/** @typedef {{ t: number, fiveHourPct: number | null, weeklyPct: number | null }} DesktopSample */
export const usableFiveHour = (/** @type {DesktopSample[]} */ samples) => /** @type {(DesktopSample & { fiveHourPct: number })[]} */ (samples).filter((s) => s.fiveHourPct != null && s.fiveHourPct >= MIN_CALIBRATION_PCT && s.fiveHourPct <= DESKTOP.usableMax);

/**
 * Leave-one-out check of the log-based estimate against the app's own figures: for each usable sample, fit the five-hour limit from the OTHER
 * samples and estimate the percentage from the logs' spend in that window. A sample whose window has no spend in the logs is reported as
 * unseen (the usage came from somewhere the logs do not cover: chat, Cowork, another machine), and is not counted in the error.
 */
/** @param {DesktopSample[]} samples @param {{ t: number, cost: number }[]} events */
export function checkAgainstLogs(samples, events) {
  const use = usableFiveHour(samples);
  const wins = fiveHourWindows(events.map((e) => e.t));
  const rows = use.map((s) => {
    const w = wins.find((x) => s.t >= x.start && s.t < x.end);
    return { ...s, spendUSD: w ? spendIn(events, w.start, s.t) : 0 };
  });
  const checked = rows.map((r, i) => {
    const others = rows.filter((o, j) => j !== i && o.spendUSD > 0).map((o) => o.spendUSD / (o.fiveHourPct / 100));
    const limit = median(others);
    if (!(r.spendUSD > 0)) return { t: r.t, appPct: r.fiveHourPct, estimatePct: null, errorPoints: null, seen: false };
    if (!limit) return { t: r.t, appPct: r.fiveHourPct, estimatePct: null, errorPoints: null, seen: true, note: "no other sample to fit a limit from" };
    const est = Math.min(100, (r.spendUSD / limit) * 100);
    return { t: r.t, appPct: r.fiveHourPct, estimatePct: Math.round(est), errorPoints: Math.round(est - r.fiveHourPct), seen: true };
  });
  const scored = checked.filter((c) => c.errorPoints != null);
  const absErr = scored.map((c) => Math.abs(c.errorPoints));
  return {
    samples: samples.length,
    usable: use.length,
    checked,
    scored: scored.length,
    unseen: checked.filter((c) => !c.seen).length,
    medianAbsErrorPoints: median(absErr),
    withinTenPoints: scored.filter((c) => Math.abs(c.errorPoints) <= 10).length,
    confidence: scored.length >= 10 ? "measured against the app's own figures" : `a small check (${scored.length} sample${scored.length === 1 ? "" : "s"}); treat as indicative`
  };
}
