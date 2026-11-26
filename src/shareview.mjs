// @ts-check
/**
 * The share-safe form of an output: what is left when the parts that identify you are taken out. Dates stay (the day), times, session ids,
 * and anything else that points at a person or a machine go. A post cannot be taken back, so each output has this form and `--share`
 * checks it with the same scanner as `sparelimit safe-to-share` before it is called safe. The numbers are not changed.
 */

const day = (/** @type {string | null | undefined} */ iso) => (iso ? String(iso).slice(0, 10) : iso ?? null);

/** The ledger with days instead of times and no session ids. @param {any} l */
export function shareLedger(l) {
  return {
    ...l,
    entries: (l.entries || []).map((/** @type {any} */ { sessionId, at, ...e }) => ({ at: day(at), ...e })),
    shareSafe: "Days only, no times and no session ids. The numbers are the ledger's own."
  };
}

/** The weekly summary with days instead of times. @param {any} w */
export function shareWeek(w) {
  return { ...w, from: day(w.from), to: day(w.to), shareSafe: "Days only, no times. The numbers are the summary's own." };
}

/** One line of the ledger, with the day only. @param {string} at ISO time */
export const shareDay = day;
