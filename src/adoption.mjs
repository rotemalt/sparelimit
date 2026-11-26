import { RISK } from "./models.mjs";
import { readJson, writeJsonAtomic, stateDir } from "./state.mjs";
import path from "node:path";

/**
 * Adoption tracking (coach K11): did a habit change, and did the cost come down?
 *
 * Each habit has one behaviour that the logs can show, measured as a RATE (per 100 responses, or a share), so a busier week does not
 * look like a worse habit. A habit has a start date (declared with `sparelimit adopt`, else the first time Sparelimit's coach nudged about it);
 * the periods before and after it are compared. Both must hold at least MIN_RESPONSES main-thread responses, and a change must be
 * both relatively (25%) and absolutely large enough to count.
 *
 * Verdicts: improved / worse / no clear change / too early / not enough data. "Improved" says the behaviour moved the right way, not
 * that the user adopted the habit or that the habit caused it.
 *
 * What this is not: proof of cause. Workloads differ between periods. The numbers and sample sizes are shown so the reader can judge.
 */
const DAY = 86400e3;
export const MIN_RESPONSES = 50;
export const MIN_RELATIVE_CHANGE = 0.25;
const REL = MIN_RELATIVE_CHANGE;

/**
 * @typedef {{ t: number, cost: number, side?: boolean, pct?: number | null, coldUSD: number, exp?: boolean, type: string }} TimelineEvent one response of a replayed session
 * @typedef {{ start: number, startTokens: number }} SessionStart
 * @typedef {keyof typeof HABITS} HabitId
 * @typedef {ReturnType<typeof metricsFor>} Metrics
 */
export const HABITS = {
  "reset-early": { title: "Start fresh at ~60% of the window", metric: "ctxHighShare", unit: "% of responses sent at 60%+ of the context window", minAbs: 2, nudge: "context.reset" },
  "no-cold-resume": { title: "Do not resume a big conversation after a break", metric: "coldPer100", unit: "cold-cache returns per 100 responses", minAbs: 0.2, nudge: "cache.cold" },
  "model-low-risk": { title: "Run low-risk work on Sonnet", metric: "expLowShare", unit: "% of low-risk work (commands, exploring, driving tools) that ran on Opus or Fable", minAbs: 5, nudge: null },
  subagents: { title: "Keep subagent swarms in check", metric: "sideShare", unit: "% of spend that went to subagents", minAbs: 2, nudge: null },
  "start-context": { title: "Trim the fixed starting context", metric: "startMedian", unit: "tokens of starting context (median per new session)", minAbs: 5000, nudge: null }
};

export const adoptionPath = () => path.join(stateDir(), "adoption.json");
export const readMarkers = () => readJson(adoptionPath(), {});
/** @param {string} habit @param {string | number | Date} date */
export function setMarker(habit, date, now = Date.now()) {
  const m = readMarkers();
  m[habit] = { date: new Date(date).toISOString().slice(0, 10), declaredAt: new Date(now).toISOString() };
  writeJsonAtomic(adoptionPath(), m);
}
/** @param {string} habit */
export function clearMarker(habit) {
  const m = readMarkers();
  delete m[habit];
  writeJsonAtomic(adoptionPath(), m);
}

const median = (/** @type {number[]} */ a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const r1 = (/** @type {number | null | undefined} */ n) => (n == null ? null : Math.round(n * 10) / 10);

/** Behaviour and outcome numbers for events in (from, to]; sessions that STARTED in the period give the starting-context figure. */
/** @param {TimelineEvent[]} timeline @param {SessionStart[]} sessions @param {number} from @param {number} to */
export function metricsFor(timeline, sessions, from, to) {
  const ev = timeline.filter((e) => e.t > from && e.t <= to);
  const main = ev.filter((e) => !e.side);
  const cost = ev.reduce((n, e) => n + e.cost, 0);
  const low = ev.filter((e) => /** @type {Record<string, string>} */ (RISK)[e.type] === "low");
  const lowCost = low.reduce((n, e) => n + e.cost, 0);
  const side = ev.filter((e) => e.side).reduce((n, e) => n + e.cost, 0);
  const starts = sessions.filter((s) => s.start > from && s.start <= to && s.startTokens > 0).map((s) => s.startTokens);
  const n = main.length;
  return {
    from: new Date(from).toISOString().slice(0, 10),
    to: new Date(to).toISOString().slice(0, 10),
    responses: n,
    costUSD: r1(cost),
    costPer100: n ? r1((cost / n) * 100) : null,
    ctxHighShare: n ? r1((main.filter((e) => e.pct != null && e.pct >= 60).length / n) * 100) : null,
    coldPer100: n ? Math.round((main.filter((e) => e.coldUSD > 0).length / n) * 10000) / 100 : null,
    coldUSD: r1(ev.reduce((x, e) => x + e.coldUSD, 0)),
    expLowShare: lowCost > 0 ? r1((low.filter((e) => e.exp).reduce((x, e) => x + e.cost, 0) / lowCost) * 100) : null,
    sideShare: cost > 0 ? r1((side / cost) * 100) : null,
    startMedian: starts.length >= 3 ? median(starts) : null,
    newSessions: starts.length
  };
}

/**
 * Verdict for one habit given its two periods.
 * @param {HabitId} habit @param {Metrics} before @param {Metrics} after
 * @returns {{ verdict: string, reason: string, changePct?: number | null }}
 */
export function judge(habit, before, after) {
  const h = HABITS[habit];
  if (before.responses < MIN_RESPONSES || after.responses < MIN_RESPONSES) return { verdict: "not enough data", reason: `${before.responses} responses before and ${after.responses} after; at least ${MIN_RESPONSES} in each are needed` };
  const b = /** @type {Record<string, any>} */ (before)[h.metric];
  const a = /** @type {Record<string, any>} */ (after)[h.metric];
  if (b == null || a == null) return { verdict: "not enough data", reason: "this behaviour could not be measured in one of the periods" };
  const abs = a - b;
  const rel = b === 0 ? (a === 0 ? 0 : Infinity) : abs / b;
  if (Math.abs(abs) < h.minAbs || Math.abs(rel) < REL) return { verdict: "no clear change", reason: `${Math.round(b * 100) / 100} → ${Math.round(a * 100) / 100}`, changePct: Number.isFinite(rel) ? Math.round(rel * 100) : null };
  return { verdict: abs < 0 ? "improved" : "worse", reason: `${Math.round(b * 100) / 100} → ${Math.round(a * 100) / 100}`, changePct: Number.isFinite(rel) ? Math.round(rel * 100) : null };
}

/**
 * @param {object} p
 * @param {any[]} p.results replay results with timelines (replayAll)
 * @param {number} [p.now]
 * @param {Record<string, { date?: string }>} [p.markers] { habit: { date } } declared start dates
 * @param {any[]} [p.auditRows] audit log rows; the first coach nudge for a habit is its start date when none was declared
 */
export function buildAdoption({ results, markers = {}, auditRows = /** @type {any[]} */ ([]), now = Date.now() }) {
  /** @type {TimelineEvent[]} */
  const timeline = results.flatMap((r) => r.timeline || []);
  const sessions = results.map((/** @type {any} */ r) => ({ start: Date.parse(r.start), startTokens: r.spendBreakdown?.startContextTokens || 0 }));
  /** @type {Record<string, number>} */
  const firstNudge = {};
  for (const row of auditRows) if (row.kind === "coach") for (const [id, h] of Object.entries(HABITS)) if (h.nudge === row.rule) firstNudge[id] = Math.min(firstNudge[id] ?? Infinity, Date.parse(row.t));
  const habits = (/** @type {[HabitId, (typeof HABITS)[HabitId]][]} */ (Object.entries(HABITS))).map(([id, h]) => {
    const declared = markers[id]?.date ? Date.parse(`${markers[id].date}T00:00:00Z`) : null;
    const start = declared ?? (Number.isFinite(firstNudge[id]) ? firstNudge[id] : null);
    const source = declared != null ? "declared" : start != null ? "first nudge" : "none";
    let after, before, periodNote;
    if (start == null) {
      after = metricsFor(timeline, sessions, now - 14 * DAY, now);
      before = metricsFor(timeline, sessions, now - 28 * DAY, now - 14 * DAY);
      periodNote = "no start date: the last 14 days against the 14 before";
    } else {
      const len = Math.min(now - start, 56 * DAY);
      after = metricsFor(timeline, sessions, start, now);
      before = metricsFor(timeline, sessions, start - len, start);
      periodNote = `${source === "declared" ? "started" : "first nudge"} ${new Date(start).toISOString().slice(0, 10)}: ${Math.round((now - start) / DAY)} days after against ${Math.round(len / DAY)} before`;
    }
    const tooEarly = start != null && now - start < 7 * DAY;
    const j = tooEarly ? { verdict: "too early", reason: `only ${Math.floor((now - start) / DAY)} days since the start; give it 7` } : judge(id, before, after);
    const cost = before.costPer100 != null && after.costPer100 != null && before.responses >= MIN_RESPONSES && after.responses >= MIN_RESPONSES ? { before: before.costPer100, after: after.costPer100, changePct: before.costPer100 ? Math.round(((after.costPer100 - before.costPer100) / before.costPer100) * 100) : null } : null;
    const weekly = [5, 4, 3, 2, 1, 0].map((i) => {
      const m = metricsFor(timeline, sessions, now - (i + 1) * 7 * DAY, now - i * 7 * DAY);
      return { weekEnding: m.to, value: m.responses >= 20 || h.metric === "startMedian" ? /** @type {Record<string, any>} */ (m)[h.metric] : null };
    });
    return { id, title: h.title, unit: h.unit, metric: h.metric, start: start != null ? { date: new Date(start).toISOString().slice(0, 10), source } : null, periodNote, before, after, verdict: j.verdict, reason: j.reason, changePct: j.changePct ?? null, costPer100: cost, weekly };
  });
  return { habits, minResponses: MIN_RESPONSES, note: "A before/after is not proof that the habit caused the change: the work differs between periods. Behaviours are rates, so a busier week is not a worse habit. 'Cost per 100 responses' is the outcome, and it moves with the kind of work too." };
}
