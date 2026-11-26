// @ts-check
/**
 * The one way Sparelimit shows where its alerts went. Every alert ends in exactly one of these places, so the parts must add up to the
 * total, and anything that shows a breakdown (the weekly summary, the card, the product page, the README example) uses this and nothing else.
 *
 *   counted + ignored + unsettled + pending + work stopped (+ overlapping, when there is one) = alerts that fired
 *
 * "unsettled" is the ledger's `no-data`: the logs could not settle whether the alert helped.
 */

/** In the order they are shown. `ledger` is the key in `ledger.totals`. */
export const PARTS = [
  { id: "counted", word: "counted", ledger: "counted" },
  { id: "ignored", word: "ignored", ledger: "ignored" },
  { id: "unsettled", word: "unsettled", ledger: "noData" },
  { id: "pending", word: "pending", ledger: "pending" },
  { id: "stopped", word: "work stopped", ledger: "stopped" },
  { id: "overlap", word: "overlapping a saving already counted", ledger: "overlap" }
];

/**
 * @param {Record<string, any>} totals `ledger.totals`
 * @returns {{ total: number, parts: { id: string, word: string, n: number }[], sums: boolean }}
 */
export function breakdownFromTotals(totals) {
  const parts = PARTS.map((p) => ({ id: p.id, word: p.word, n: Number(totals[p.ledger]) || 0 })).filter((p) => p.n > 0 || p.id === "counted");
  const total = Number(totals.interventions) || 0;
  return { total, parts, sums: parts.reduce((n, p) => n + p.n, 0) === total };
}

/** True when the parts add up to the total. */
export const addsUp = (/** @type {{ total: number, parts: { n: number }[] }} */ b) => !!b && Array.isArray(b.parts) && b.parts.reduce((n, p) => n + p.n, 0) === b.total;

/** "3 counted + 68 ignored + 16 unsettled + 1 pending + 1 work stopped = 89" */
export const breakdownEquation = (/** @type {{ total: number, parts: { word: string, n: number }[] }} */ b) => `${b.parts.map((p) => `${p.n} ${p.word}`).join(" + ")} = ${b.total}`;
