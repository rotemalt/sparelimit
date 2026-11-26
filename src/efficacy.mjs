/**
 * Intervention efficacy (X8): after each warning, stop, nudge or playbook message in the audit log, what did the session's spending do in
 * the next 15 minutes compared with the 15 before? Per rule: how many were measurable and in how many the pace dropped, held or rose,
 * and in how many the session went quiet (no responses at all in the 15 minutes after).
 *
 * What it is not: proof the message caused anything. People stop to eat. A drop after a warning and a drop after nothing look the same,
 * so every number is "derived: what followed", and the quiet ones are counted apart because "the warning worked" and "they went to lunch" are
 * indistinguishable in a log. Only the main thread of the session that got the message is looked at (not subagents).
 */
export const EFFICACY = { windowMin: 15, minBefore: 3, slowedBelow: 0.7, roseAbove: 1.3, rules: /** @type {string[] | null} */ (null) };
const MIN = 60e3;

/**
 * @param {{ t: string, kind?: string, rule?: string, sessionId?: string }[]} auditRows
 * @param {{ sessionId: string, timeline?: { t: number, cost: number, side?: boolean }[] }[]} results
 * @param {{ now?: number, sinceMs?: number }} [opts]
 */
export function buildEfficacy(auditRows, results, { now = Date.now(), sinceMs = 0 } = {}) {
  const w = EFFICACY.windowMin * MIN;
  const bySession = new Map(results.map((r) => [r.sessionId, (r.timeline || []).filter((e) => !e.side)]));
  /** @type {Map<string, { rule: string, measured: number, slowed: number, held: number, rose: number, quiet: number, tooRecent: number, noData: number }>} */
  const rows = new Map();
  // one message per rule and session within a window counts once: a rule that repeats every minute is one intervention
  /** @type {Map<string, number>} */
  const lastCounted = new Map();
  const sorted = auditRows.filter((r) => r.rule && (r.kind === "finding" || r.kind === "coach" || r.kind === "playbook") && r.sessionId).map((r) => ({ ...r, ms: Date.parse(r.t) })).filter((r) => Number.isFinite(r.ms) && r.ms >= sinceMs).sort((a, b) => a.ms - b.ms);
  for (const r of sorted) {
    const key = `${r.rule}|${r.sessionId}`;
    if (lastCounted.has(key) && r.ms - /** @type {number} */ (lastCounted.get(key)) < w) continue;
    lastCounted.set(key, r.ms);
    const row = rows.get(/** @type {string} */ (r.rule)) || { rule: /** @type {string} */ (r.rule), measured: 0, slowed: 0, held: 0, rose: 0, quiet: 0, tooRecent: 0, noData: 0 };
    rows.set(row.rule, row);
    const tl = bySession.get(/** @type {string} */ (r.sessionId));
    if (!tl) {
      row.noData += 1;
      continue;
    }
    if (r.ms + w > now) {
      row.tooRecent += 1;
      continue;
    }
    const before = tl.filter((e) => e.t > r.ms - w && e.t <= r.ms);
    const after = tl.filter((e) => e.t > r.ms && e.t <= r.ms + w);
    if (before.length < EFFICACY.minBefore) {
      row.noData += 1;
      continue;
    }
    if (!after.length) {
      row.quiet += 1;
      continue;
    }
    const b = before.reduce((n, e) => n + e.cost, 0);
    const a = after.reduce((n, e) => n + e.cost, 0);
    row.measured += 1;
    const ratio = b > 0 ? a / b : 1;
    if (ratio < EFFICACY.slowedBelow) row.slowed += 1;
    else if (ratio > EFFICACY.roseAbove) row.rose += 1;
    else row.held += 1;
  }
  const out = [...rows.values()].sort((x, y) => y.measured + y.quiet - (x.measured + x.quiet));
  return { rules: out, windowMin: EFFICACY.windowMin, confidence: "derived", note: `For each message, the spend in the ${EFFICACY.windowMin} minutes after against the ${EFFICACY.windowMin} before (main thread of that session). "Slowed" is under ${Math.round(EFFICACY.slowedBelow * 100)}% of the earlier pace, "rose" over ${Math.round(EFFICACY.roseAbove * 100)}%. This shows what followed, not what the message caused: people also stop for other reasons, and a session that went quiet is counted apart.` };
}
