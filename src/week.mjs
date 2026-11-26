/**
 * The weekly summary: what happened in the last seven days, read from what `sparelimit ledger` already counts. It only reads the ledger and prints.
 *
 * Every figure is the ledger's own and carries one of the three labels (exact / derived / estimated):
 *   alerts, acted on, ignored ...  derived  (counted from the audit log and the session logs, arithmetic only)
 *   counted saving                 estimated (two stretches of work are compared and the ledger itself says "the work may differ")
 * The counted saving is `ledger.totals.countedUSD`, unchanged. It can be negative: if the cost went up afterwards, it says so.
 */
import { breakdownEquation, breakdownFromTotals } from "./breakdown.mjs";
import { buildLedger, LEDGER_RULES_VERSION } from "./ledger.mjs";
import { readAuditRows, replayAll } from "./transcripts.mjs";
import { fitLimits, loadCalibration } from "./planestimate.mjs";

const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;
const DAY = 86400e3;
export const SUMMARY_DAYS = 7;

/**
 * @param {ReturnType<typeof buildLedger>} ledger a ledger built for the same window
 * @param {{ days?: number, now?: number }} [opts]
 */
export function buildWeek(ledger, { days = SUMMARY_DAYS, now = Date.now() } = {}) {
  const t = ledger.totals;
  const savingLabel = t.counted ? "estimated" : "derived";
  /** @type {{ reason: string, n: number, why: string, predictedUSD?: number }[]} */
  const notCounted = [
    { reason: "ignored", n: t.ignored, why: "you did not act on the alert, so nothing was saved", ...(t.ignoredPredictedUSD ? { predictedUSD: t.ignoredPredictedUSD } : {}) },
    { reason: "stopped", n: t.stopped, why: "work stopped after the alert; that is not counted as an effect of it" },
    { reason: "no-data", n: t.noData, why: "the logs could not settle it (too little spending to compare, or the alert did not apply)" },
    { reason: "pending", n: t.pending, why: "too recent to judge: the window after the alert is not over" },
    { reason: "overlap", n: t.overlap, why: "overlaps a saving already counted, so it is not counted twice" }
  ].filter((x) => x.n > 0);
  return {
    rulesVersion: ledger.rulesVersion ?? LEDGER_RULES_VERSION,
    days,
    from: days ? new Date(now - days * DAY).toISOString() : null,
    to: new Date(now).toISOString(),
    alerts: { value: t.interventions, label: "derived" },
    breakdown: { ...breakdownFromTotals(t), label: "derived" },
    actedOn: { value: t.actedOn, label: "derived" },
    ignored: { value: t.ignored, label: "derived" },
    counted: { alerts: t.counted, savingUSD: t.countedUSD, label: savingLabel },
    notCounted,
    note: "An alert is what the ledger counts as one (repeats within 30 minutes are one). Dollars are API-equivalent at list price: on a subscription a saving is limit you kept, not money back. Whether an alert was the reason you acted is not known."
  };
}

/** Reads this machine's logs and builds the summary. Returns null when there are no Claude Code transcripts. */
export function readWeek(/** @type {{ days?: number, now?: number }} */ { days = SUMMARY_DAYS, now = Date.now() } = {}) {
  const all = replayAll();
  if (!all) return null;
  const ledger = buildLedger({ auditRows: readAuditRows(), results: all.results, now, weeklyLimitUSD: fitLimits(loadCalibration().points).weeklyUSD, sinceMs: days ? now - days * DAY : 0 });
  return { week: buildWeek(ledger, { days, now }), ledger };
}

const usd = (/** @type {number} */ n) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** @param {ReturnType<typeof buildWeek>} w */
export function renderWeekText(w) {
  const day = (/** @type {string | null} */ iso) => (iso ? iso.slice(0, 10) : "the first alert");
  const row = (/** @type {string} */ k, /** @type {string} */ v, /** @type {string} */ label, /** @type {string} */ extra = "") => `${k.padEnd(30)}${v.padStart(10)}   [${label}]${extra ? `  ${extra}` : ""}`;
  const out = [`\n⚡ SPARELIMIT WEEKLY SUMMARY: ${w.days ? `the last ${w.days} days` : "everything on this machine"} (${day(w.from)} to ${day(w.to)})`, "──────────────────────────────────────────────────────────────", ""];
  if (!w.alerts.value) {
    out.push("No alert fired in this period, so there is nothing to count. A saving is counted only when an alert fired, you acted,", "and a comparable cost was measured afterwards.");
  } else {
    out.push(row("Alerts that fired", String(w.alerts.value), w.alerts.label));
    out.push(`  Where they went: ${breakdownEquation(w.breakdown)}`);
    out.push(row("Acted on", String(w.actedOn.value), w.actedOn.label, `(${w.ignored.value} ignored)`));
    out.push(row("Counted saving", usd(w.counted.savingUSD), w.counted.label, `from ${w.counted.alerts} alert${w.counted.alerts === 1 ? "" : "s"}`));
    out.push("", "Not counted, and why:");
    if (!w.notCounted.length) out.push("  nothing: every alert in this period was counted");
    for (const x of w.notCounted) out.push(`  ${String(x.n).padStart(3)} ${x.reason.padEnd(8)} ${x.why}${x.predictedUSD ? ` (they predicted ${usd(x.predictedUSD)}, which was not saved)` : ""}`);
  }
  out.push("", w.note, `Rules version ${w.rulesVersion}: every rule and threshold is in docs/RULES.md.`, "How every number here is computed, and what exact / derived / estimated mean: `sparelimit method`.\n");
  return out.join("\n");
}
