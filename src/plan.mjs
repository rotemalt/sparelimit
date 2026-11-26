import { windowOutlook, FIVE_HOURS, SEVEN_DAYS } from "./rates.mjs";
import { readJson, snapshotPath } from "./state.mjs";

const MAX_AGE_MS = 24 * 3600e3;

/** Plan-limit outlook for a session from its latest collector snapshot (exact data), or null if none/too old. */
export function planOutlook(/** @type {string} */ sessionId, now = Date.now()) {
  const snap = readJson(snapshotPath(sessionId));
  if (!snap || now - (snap.receivedAtMs || 0) > MAX_AGE_MS) return null;
  const fh = snap.rateLimits?.fiveHour;
  const sd = snap.rateLimits?.sevenDay;
  if (!fh && !sd) return { account: snap.account?.label || null, fiveHour: null, sevenDay: null, ageMin: Math.round((now - snap.receivedAtMs) / 60e3), note: "no quota data (API-key session, or the status line has not reported yet)" };
  return {
    account: snap.account?.label || null,
    ageMin: Math.round((now - snap.receivedAtMs) / 60e3),
    fiveHour: fh ? windowOutlook(fh, { ratePctPerHour: snap.burn?.fiveHourPctPerHour ?? null, windowMs: FIVE_HOURS, now }) : null,
    sevenDay: sd ? windowOutlook(sd, { ratePctPerHour: snap.burn?.sevenDayPctPerHour ?? null, windowMs: SEVEN_DAYS, now }) : null,
    confidence: "exact"
  };
}

const dur = (/** @type {any} */ min) => (min == null ? "?" : min >= 1440 ? `${(min / 1440).toFixed(1)}d` : min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m` : `${min}m`);

export function describeWindow(/** @type {string} */ name, /** @type {any} */ o) {
  if (!o) return null;
  const rate = o.ratePctPerHour != null ? `, burning ${o.ratePctPerHour}%/h` : "";
  const verdict = o.minutesToLimit == null ? "" : o.lastsUntilReset ? ` → lasts until reset` : ` → runs out in ~${dur(o.minutesToLimit)}, before the reset`;
  return `${name} ${Math.round(o.pct)}% used, resets in ${dur(o.resetsInMin)}${rate}${verdict}`;
}
