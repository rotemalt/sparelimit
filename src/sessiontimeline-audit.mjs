/** Alerts and nudges Sparelimit showed in one session, from the audit log: the same rule within 30 minutes is one entry with a count. */
export function auditSessionRows(/** @type {any} */ auditRows, /** @type {string} */ sessionId) {
  const rows = auditRows.filter((/** @type {any} */ r) => r.sessionId === sessionId && (r.kind === "finding" || r.kind === "coach") && Number.isFinite(Date.parse(r.t))).sort((/** @type {any} */ a, /** @type {any} */ b) => Date.parse(a.t) - Date.parse(b.t));
  const open = new Map();
  const out = [];
  for (const r of rows) {
    const ms = Date.parse(r.t);
    const cur = open.get(r.rule);
    if (cur && ms - cur.last <= 30 * 60e3) {
      cur.last = ms;
      cur.count += 1;
      continue;
    }
    const e = { t: ms, last: ms, rule: r.rule, message: r.message || r.rule, count: 1 };
    open.set(r.rule, e);
    out.push(e);
  }
  return out.map(({ last, ...e }) => e);
}
