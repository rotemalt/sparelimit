/**
 * Savings ledger (X1): the proof layer. A saving is COUNTED only when all three hold:
 *   1. an alert fired (a row in the audit log),
 *   2. the user acted (visible in the logs afterwards: the conversation shrank or restarted; the spend rate fell and work continued),
 *   3. a comparable cost was measured on the other side of the action (same session, same project, or the same account).
 * Everything else is listed but NOT counted: ignored alerts (with what they predicted), alerts too recent to judge, and alerts the
 * logs cannot settle. Counted savings can be negative: if the cost went up afterwards, the ledger says so.
 *
 * Three evaluators, one per kind of alert:
 *   reset  (context.reset coach nudge, context.window warning): the context fell by 35% or more within 15 responses (a /compact), or a
 *          new conversation started in the same project within an hour with a small start. Saving = (mean cost per response in the 10
 *          before - mean in the next 30 after) x those responses.
 *   cold   (cache.cold coach nudge): no cold-cache response followed, and a new conversation started in the same project within 45
 *          minutes. Saving = the nudge's resume cost (tokens x price, derived) - the measured cost of the new conversation's first 3
 *          responses.
 *   rate   (quota.* warnings, all sessions together): spend in the 30 minutes after was at most 70% of the 30 before AND work continued
 *          (5+ responses; stopping work is not an effect of the alert). Saving = the difference over those 30 minutes. It assumes the
 *          earlier pace would have continued, which is why it is labelled so.
 * Repeated warnings for the same thing within 30 minutes are one intervention, and a rate saving that overlaps a counted reset or cold
 * saving is not counted twice.
 */
const MIN = 60e3;
/**
 * @typedef {{ t: string, kind?: string, rule: string, sessionId?: string, evidence?: any, [k: string]: any }} AuditRow one line of audit.jsonl
 * @typedef {{ family: string, t: number, sessionId?: string, rules: Set<string>, rows: number, lastMs: number, evidence: any }} Intervention
 * @typedef {ReturnType<typeof index>} LedgerIndex
 */
const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;
const mean = (/** @type {number[]} */ a) => (a.length ? a.reduce((n, x) => n + x, 0) / a.length : 0);

/**
 * The rules' version. The ledger is a judge, and a judge that changes its rules after seeing the work is not one. Any change to a number in
 * LEDGER, to FAMILIES or to the rule text in `docs/RULES.md` is a new version: raise this number, add the new version to
 * `docs/CHANGELOG.md` and to `docs/rules-lock.json`, and leave every earlier version's entry exactly as it was. A test fails otherwise.
 */
export const LEDGER_RULES_VERSION = 1;

/** Every number that decides what the ledger counts. Nothing that decides an outcome is written anywhere else. */
export const LEDGER = {
  clusterGapMin: 30, // repeated alerts of one kind within this many minutes are one alert
  resetDropRatio: 0.65, // reset: the context fell to this share of what it was, or less
  resetWithinResponses: 15, // reset: ...within this many responses after the alert
  minPreResponses: 5, // reset: fewer responses than this before the alert and it cannot be judged
  preResponses: 10, // reset: responses before the alert that the "before" cost is measured on
  postResponses: 30, // reset: responses after the action that the "after" cost is measured on
  minPost: 10, // reset: fewer responses than this after the action and it cannot be judged
  restartWithinMin: 60, // reset: a new conversation in the same project within this many minutes counts as a restart...
  restartStartRatio: 0.5, // reset: ...if it started at this share of the old context or less
  pendingHours: 3, // reset: too recent to judge until this many hours have passed
  coldRestartWithinMin: 45, // cold: a new conversation in the same project within this many minutes
  coldCheckMin: 5, // cold: a cold return within this many minutes of the alert means the alert was ignored
  coldPendingHours: 1, // cold: too recent to judge until this many hours have passed
  coldFirstResponses: 3, // cold: the new conversation's first responses that its cost is measured on
  rateMinutes: 30, // plan limit: spending is compared over this many minutes before and after
  rateSlowdown: 0.7, // plan limit: the after-spend must be at most this share of the before-spend
  rateMinBeforeUSD: 0.5, // plan limit: less spending than this before and there is nothing to compare
  rateMinResponses: 5 // plan limit: fewer responses than this after and work is treated as stopped
};

/** Which audit rows are alerts, and which kind of alert each is. */
export const FAMILIES = [
  { family: "cold", kind: "coach", rule: "cache.cold" },
  { family: "reset", kind: "coach", rule: "context.reset" },
  { family: "reset", kind: "finding", rule: "context.window" },
  { family: "quota", kind: "finding", rule: "quota.*" }
];

/** Every place an alert can end. The sum of these is the number of alerts. */
export const STATUSES = ["counted", "ignored", "no-data", "pending", "stopped", "overlap"];

const family = (/** @type {AuditRow} */ row) => FAMILIES.find((f) => f.kind === row.kind && (f.rule.endsWith("*") ? String(row.rule).startsWith(f.rule.slice(0, -1)) : row.rule === f.rule))?.family ?? null;

/**
 * Group audit rows into interventions: quota alerts across sessions by time, the others per session and kind.
 * @param {AuditRow[]} auditRows
 * @returns {Intervention[]}
 */
export function interventions(auditRows) {
  /** @type {(AuditRow & { ms: number, fam: string })[]} */
  const rows = /** @type {any[]} */ (auditRows.map((r) => ({ ...r, ms: Date.parse(r.t), fam: family(r) }))).filter((r) => r.fam && Number.isFinite(r.ms)).sort((a, b) => a.ms - b.ms);
  /** @type {Map<string, Intervention>} */
  const open = new Map();
  /** @type {Intervention[]} */
  const out = [];
  for (const r of rows) {
    const key = r.fam === "quota" ? "quota" : `${r.fam}|${r.sessionId}`;
    const cur = open.get(key);
    if (cur && r.ms - cur.lastMs <= LEDGER.clusterGapMin * MIN) {
      cur.lastMs = r.ms;
      cur.rows += 1;
      cur.rules.add(r.rule);
      continue;
    }
    const iv = { family: r.fam, t: r.ms, sessionId: r.sessionId, rules: new Set([r.rule]), rows: 1, lastMs: r.ms, evidence: r.evidence || {} };
    open.set(key, iv);
    out.push(iv);
  }
  return out;
}

/** @param {{ sessionId: string, project?: string, start: string, timeline?: any[] }[]} results */
function index(results) {
  const sessions = results.map((r) => ({ id: r.sessionId, project: r.project, start: Date.parse(r.start), main: (r.timeline || []).filter((e) => !e.side).sort((a, b) => a.t - b.t) }));
  const all = results.flatMap((r) => r.timeline || []).sort((a, b) => a.t - b.t);
  return { sessions, byId: new Map(sessions.map((s) => [s.id, s])), all };
}

/** @returns {any} one alert's verdict: status plus the measured before/after when counted */
/** @param {Intervention} iv @param {LedgerIndex} ix @param {number} now */
function evalReset(iv, ix, now) {
  const S = ix.byId.get(iv.sessionId || "");
  if (!S) return { status: "no-data", note: "that session's log was not found" };
  const pre = S.main.filter((e) => e.t <= iv.t).slice(-LEDGER.preResponses);
  if (pre.length < LEDGER.minPreResponses) return { status: "no-data", note: `fewer than ${LEDGER.minPreResponses} responses before the alert` };
  const pctPre = pre[pre.length - 1].pct;
  const cPre = mean(pre.map((e) => e.cost));
  const post = S.main.filter((e) => e.t > iv.t);
  const k = post.slice(0, LEDGER.resetWithinResponses).findIndex((e) => pctPre != null && e.pct != null && e.pct <= pctPre * LEDGER.resetDropRatio);
  let after = null;
  let how = null;
  if (k >= 0) {
    after = post.slice(k, k + LEDGER.postResponses);
    how = "context shrank in the same conversation (/compact)";
  } else {
    const next = ix.sessions.filter((s) => s.project && s.project === S.project && s.id !== S.id && s.start > iv.t && s.start <= iv.t + LEDGER.restartWithinMin * MIN).sort((a, b) => a.start - b.start)[0];
    if (next && next.main[0]?.pct != null && next.main[0].pct <= (pctPre ?? 100) * LEDGER.restartStartRatio) {
      after = next.main.slice(0, LEDGER.postResponses);
      how = "a new conversation started in the same project with a small start";
    }
  }
  if (!after) {
    if (now - iv.t < LEDGER.pendingHours * 3600e3) return { status: "pending", note: `less than ${LEDGER.pendingHours} hours since the alert` };
    return { status: "ignored", note: "the conversation kept growing and no restart followed" };
  }
  if (after.length < LEDGER.minPost) return { status: now - iv.t < LEDGER.pendingHours * 3600e3 ? "pending" : "no-data", note: `only ${after.length} responses after the action; ${LEDGER.minPost} needed` };
  const cPost = mean(after.map((e) => e.cost));
  return { status: "counted", savingUSD: r2((cPre - cPost) * after.length), how, before: { responses: pre.length, costPerResponse: r2(cPre), contextPct: pctPre }, after: { responses: after.length, costPerResponse: r2(cPost) }, method: `measured before/after: mean cost per response in the ${LEDGER.preResponses} before the alert against the next ${LEDGER.postResponses} after the action, times those responses`, confidence: "measured before/after (the work may differ)" };
}

/** @returns {any} one alert's verdict: status plus the measured before/after when counted */
/** @param {Intervention} iv @param {LedgerIndex} ix @param {number} now */
function evalCold(iv, ix, now) {
  const S = ix.byId.get(iv.sessionId || "");
  if (!S) return { status: "no-data", note: "that session's log was not found" };
  const within = S.main.filter((e) => e.t > iv.t && e.t <= iv.t + LEDGER.coldCheckMin * MIN);
  if (within.some((e) => e.coldUSD > 0)) return { status: "ignored", note: "the conversation was resumed cold anyway" };
  const next = ix.sessions.filter((s) => s.project && s.project === S.project && s.id !== S.id && s.start > iv.t && s.start <= iv.t + LEDGER.coldRestartWithinMin * MIN).sort((a, b) => a.start - b.start)[0];
  if (!next || within.length) {
    if (now - iv.t < LEDGER.coldPendingHours * 3600e3) return { status: "pending", note: "less than an hour since the alert" };
    return within.length ? { status: "no-data", note: "the conversation continued without a cold return, so the alert did not apply" } : { status: "ignored", note: "no restart followed" };
  }
  const first = next.main.slice(0, LEDGER.coldFirstResponses);
  if (first.length < LEDGER.coldFirstResponses) return { status: "no-data", note: `the new conversation has fewer than ${LEDGER.coldFirstResponses} responses` };
  const resume = iv.evidence.resumeUSD;
  if (!(resume > 0)) return { status: "no-data", note: "the alert did not record what resuming would cost" };
  const fresh = first.reduce((n, e) => n + e.cost, 0);
  return { status: "counted", savingUSD: r2(resume - fresh), how: "started a new conversation instead of resuming", before: { resumeUSD: resume }, after: { firstResponsesUSD: r2(fresh), responses: first.length }, method: `resuming's cost (tokens x price, from the alert) minus the measured cost of the new conversation's first ${LEDGER.coldFirstResponses} responses`, confidence: "derived resume cost, measured fresh-start cost" };
}

/** @returns {any} one alert's verdict: status plus the measured before/after when counted */
/** @param {Intervention} iv @param {LedgerIndex} ix @param {number} now */
function evalRate(iv, ix, now) {
  const w = LEDGER.rateMinutes * MIN;
  if (iv.t + w > now) return { status: "pending", note: `the ${LEDGER.rateMinutes} minutes after the alert are not over` };
  const before = ix.all.filter((e) => e.t > iv.t - w && e.t <= iv.t);
  const after = ix.all.filter((e) => e.t > iv.t && e.t <= iv.t + w);
  const b = before.reduce((n, e) => n + e.cost, 0);
  const a = after.reduce((n, e) => n + e.cost, 0);
  if (b < LEDGER.rateMinBeforeUSD) return { status: "no-data", note: `too little spending in the ${LEDGER.rateMinutes} minutes before to compare` };
  const info = { before: { usd: r2(b), responses: before.length }, after: { usd: r2(a), responses: after.length } };
  if (after.filter((e) => !e.side).length < LEDGER.rateMinResponses) return { status: "stopped", note: "work stopped after the alert; that is not counted as an effect of it", ...info };
  if (a > b * LEDGER.rateSlowdown) return { status: "ignored", note: `spending did not slow down (${r2(b)} → ${r2(a)} in ${LEDGER.rateMinutes} minutes)`, ...info };
  return { status: "counted", savingUSD: r2(b - a), how: "spending slowed and work continued", ...info, method: `spend in the ${LEDGER.rateMinutes} minutes after against the ${LEDGER.rateMinutes} before, work continuing; assumes the earlier pace would have continued`, confidence: "measured before/after; the earlier pace is assumed to continue" };
}

/**
 * @param {object} p
 * @param {AuditRow[]} p.auditRows rows of ~/.sparelimit/audit.jsonl
 * @param {number} [p.now]
 * @param {number|null} [p.weeklyLimitUSD]
 * @param {number} [p.sinceMs]
 * @param {any[]} p.results replay results with timelines (replayAll)
 */
export function buildLedger({ auditRows, results, now = Date.now(), weeklyLimitUSD = /** @type {number | null} */ (null), sinceMs = 0 }) {
  const ix = index(results);
  /** @type {any[]} */
  const entries = interventions(auditRows).filter((iv) => iv.t >= sinceMs).map((iv) => {
    const e = iv.family === "reset" ? evalReset(iv, ix, now) : iv.family === "cold" ? evalCold(iv, ix, now) : evalRate(iv, ix, now);
    const predictedUSD = iv.family === "reset" ? iv.evidence.savingUSD ?? null : iv.family === "cold" && iv.evidence.resumeUSD != null ? r2(Math.max(0, iv.evidence.resumeUSD - (iv.evidence.freshUSD ?? 0))) : null;
    return { at: new Date(iv.t).toISOString(), family: iv.family, rules: [...iv.rules], alerts: iv.rows, sessionId: iv.sessionId || null, predictedUSD, windowEnd: iv.t + (iv.family === "quota" ? LEDGER.rateMinutes * MIN : LEDGER.pendingHours * 3600e3), ...e };
  });
  // a rate saving that overlaps a counted reset or cold saving would count the same money twice
  const specific = entries.filter((e) => e.family !== "quota" && e.status === "counted");
  for (const e of entries) if (e.family === "quota" && e.status === "counted" && specific.some((s) => Date.parse(s.at) < e.windowEnd && s.windowEnd > Date.parse(e.at))) Object.assign(e, { status: "overlap", note: "overlaps a counted reset or cold-cache saving; not counted twice", countedUSD: e.savingUSD, savingUSD: undefined });
  const counted = entries.filter((e) => e.status === "counted");
  const by = (/** @type {string} */ st) => entries.filter((e) => e.status === st);
  const total = r2(counted.reduce((n, e) => n + e.savingUSD, 0));
  return {
    rulesVersion: LEDGER_RULES_VERSION,
    totals: {
      interventions: entries.length,
      counted: counted.length,
      countedUSD: total,
      countedPctOfWeeklyLimit: weeklyLimitUSD ? r2((total / weeklyLimitUSD) * 100) : null,
      ignored: by("ignored").length,
      actedOn: by("counted").length + by("overlap").length,
      actedOnRate: by("counted").length + by("overlap").length + by("ignored").length ? Math.round(((by("counted").length + by("overlap").length) / (by("counted").length + by("overlap").length + by("ignored").length)) * 100) : null, // of the alerts where one or the other could be told: how often you (or the agent) acted. Not a measure of whether the alert was the reason.
      ignoredPredictedUSD: r2(by("ignored").reduce((n, e) => n + (e.predictedUSD || 0), 0)),
      pending: by("pending").length,
      stopped: by("stopped").length,
      overlap: by("overlap").length,
      noData: by("no-data").length,
      byFamily: ["reset", "cold", "quota"].reduce((m, f) => ((m[f] = { counted: counted.filter((e) => e.family === f).length, countedUSD: r2(counted.filter((e) => e.family === f).reduce((n, e) => n + e.savingUSD, 0)), all: entries.filter((e) => e.family === f).length }), m), /** @type {Record<string, { counted: number, countedUSD: number, all: number }>} */ ({}))
    },
    entries: entries.map(({ windowEnd, ...e }) => e),
    note: "Only savings with an alert, an observed action and a measured cost afterwards are counted. Counted figures can be negative. Ignored alerts show what they predicted; that money was not saved. Savings are in API-equivalent dollars at list price."
  };
}
