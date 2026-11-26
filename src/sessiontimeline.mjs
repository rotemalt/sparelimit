import { DEFAULT_POLICY } from "./policy.mjs";
import { REPLAY } from "./replay.mjs";
import { DELEGATION } from "./delegation.mjs";
import { auditSessionRows } from "./sessiontimeline-audit.mjs";
import { LEDGER } from "./ledger.mjs";
import { projectLabel } from "./sources.mjs";

/**
 * The timeline of one session (D6): how the conversation grew, and what happened along the way. The x axis is the response number, not
 * the clock, so a session that spans days stays readable; long pauses are marked. Everything here is derived from the log (and the audit
 * log for what Sparelimit said), except the one estimate in the summary, which is labelled.
 *
 * Moments (each has a rule, quoted by the methodology page):
 *   threshold  the context first rose to the warning level (and to the stop level) in a climb
 *   shrank     the context fell by 35% or more between two responses (a /compact, an auto-compaction, or a /clear); carries a before/after (D7):
 *              the mean cost per response in the 10 responses before against the next 30 after (up to the next shrink), the ledger's windows
 *   cold       a response that re-processed the whole conversation after a break longer than the cache lifetime
 *   loop       the replay's loop rules fired (the same call, and the same result, repeated)
 *   errors     3 or more tool calls came back as errors within 5 consecutive responses
 *   swarm      4 or more subagents running at the same time
 *   sparelimit       an alert or nudge Sparelimit showed in this session (from the audit log)
 */
export const TIMELINE = { errorFlood: 3, errorWindow: 5, errorQuiet: 20, awayMinutes: 60, rearmBelowPct: 5 };

/** @typedef {{ n: number, t: number, pct: number | null | undefined, ctx: number | undefined, cost: number, cumUSD: number, errs: number, coldUSD: number }} MainPoint one main-thread response */
const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;
const MIN = 60e3;

const mean = (/** @type {number[]} */ xs) => xs.reduce((n, x) => n + x, 0) / xs.length;

/**
 * D7: what a response cost before a shrink against after it. Before: the 10 responses ahead of it. After: the 30 from the shrink on, cut
 * at the next shrink so two resets are not mixed. null when there is too little on either side (5 before, 10 after). Measured, but the
 * work after may differ from the work before, so it is a comparison and not proof of a saving.
 */
/** @param {MainPoint[]} main @param {number} i */
function beforeAfter(main, i) {
  const pre = main.slice(Math.max(0, i - LEDGER.preResponses), i);
  let post = main.slice(i, i + LEDGER.postResponses);
  const next = post.findIndex((p, k) => k > 0 && p.pct != null && post[k - 1].pct != null && p.pct < /** @type {number} */ (post[k - 1].pct) * REPLAY.compactionDrop);
  if (next > 0) post = post.slice(0, next);
  if (pre.length < 5 || post.length < LEDGER.minPost) return null;
  const b = mean(pre.map((p) => p.cost));
  const a = mean(post.map((p) => p.cost));
  const pcts = (/** @type {MainPoint[]} */ xs) => xs.filter((p) => p.pct != null).map((p) => /** @type {number} */ (p.pct));
  return {
    before: { responses: pre.length, costPerResponse: r2(b), meanPct: Math.round(mean(pcts(pre)) || 0) },
    after: { responses: post.length, costPerResponse: r2(a), meanPct: Math.round(mean(pcts(post)) || 0) },
    changePct: b > 0 ? Math.round(((a - b) / b) * 100) : null,
    confidence: "measured before/after (the work may differ)"
  };
}

/**
 * @param {{ result: any, auditRows?: any[] }} p
 */
export function buildSessionTimeline({ result, auditRows = [] }) {
  const all = [...(result.timeline || [])].sort((a, b) => a.t - b.t);
  /** @type {MainPoint[]} */
  const main = [];
  let cum = 0;
  for (const e of all) {
    cum += e.cost;
    if (!e.side) main.push({ n: main.length + 1, t: e.t, pct: e.pct, ctx: e.ctx, cost: r2(e.cost), cumUSD: r2(cum), errs: e.errs || 0, coldUSD: e.coldUSD || 0 });
  }
  const at = (/** @type {number} */ t) => {
    // the last response at or before t (or the first, for a moment before the session started)
    let best = main[0];
    for (const p of main) if (p.t <= t) best = p;
    return best;
  };
  /** @type {any[]} */
  const moments = [];
  const add = (/** @type {string} */ kind, /** @type {number} */ t, /** @type {string} */ label, detail = {}) => {
    const p = at(t);
    if (p) moments.push({ kind, t, n: p.n, pct: p.pct, cumUSD: p.cumUSD, label, ...detail });
  };

  // thresholds and shrinks
  const warn = /** @type {number} */ (DEFAULT_POLICY.context.warnPct); // the defaults are numbers; only a user setting can switch a level off
  const block = /** @type {number} */ (DEFAULT_POLICY.context.blockPct);
  let armedWarn = true;
  let armedBlock = true;
  main.forEach((p, i) => {
    const prev = main[i - 1];
    if (p.pct != null && p.pct >= warn && armedWarn) {
      armedWarn = false;
      add("threshold", p.t, `The context reached ${Math.round(p.pct)}% of the window (the warning level is ${warn}%).`, { level: "warn" });
    }
    if (p.pct != null && p.pct >= block && armedBlock) {
      armedBlock = false;
      add("threshold", p.t, `The context reached ${Math.round(p.pct)}% of the window (the stop level is ${block}%).`, { level: "stop" });
    }
    if (prev && prev.pct != null && p.pct != null && p.pct < prev.pct * REPLAY.compactionDrop) {
      add("shrank", p.t, `The context shrank from ${Math.round(prev.pct)}% to ${Math.round(p.pct)}% (a /compact, an auto-compaction or a /clear).`, { compare: beforeAfter(main, i) });
      armedWarn = true;
      armedBlock = true;
    } else if (p.pct != null && p.pct < warn - TIMELINE.rearmBelowPct) {
      armedWarn = true;
      armedBlock = true;
    }
    if (p.coldUSD > 0 && prev) {
      const gap = Math.round((p.t - prev.t) / MIN);
      add("cold", p.t, `Back after ${gap >= 120 ? `${(gap / 60).toFixed(1)} hours` : `${gap} minutes`}: the whole conversation was processed again, about $${r2(p.coldUSD)} more than a warm cache.`, { extraUSD: r2(p.coldUSD) });
    }
  });

  // loops, from the replay's own findings
  const seenLoop = new Set();
  for (const f of result.findings || []) {
    if (!f.rule.startsWith("loop.") || seenLoop.has(`${f.rule}|${f.level}`)) continue;
    seenLoop.add(`${f.rule}|${f.level}`);
    add("loop", Date.parse(f.t), `${f.level === "block" ? "Stop" : "Warning"}: ${f.message}`, { rule: f.rule, level: f.level });
  }

  // error floods: errors within a few consecutive responses, then quiet for a while so one bad patch is one moment
  let quietUntil = -1;
  for (let i = 0; i < main.length; i++) {
    if (i < quietUntil) continue;
    const win = main.slice(i, i + TIMELINE.errorWindow);
    const errs = win.reduce((n, p) => n + p.errs, 0);
    if (errs >= TIMELINE.errorFlood) {
      const first = win.find((p) => p.errs > 0) || win[0]; // the moment sits on the first failure, not on the start of the window (there is one: errs >= 3)
      add("errors", first.t, `${errs} tool calls came back as errors within ${win.length} responses.`, { errors: errs });
      quietUntil = i + TIMELINE.errorQuiet;
    }
  }

  // swarms: the time the number of subagents running at once first reaches the swarm level
  const span = new Map();
  for (const e of all) if (e.agent) {
    const s = span.get(e.agent) || { a: e.t, b: e.t };
    s.a = Math.min(s.a, e.t);
    s.b = Math.max(s.b, e.t);
    span.set(e.agent, s);
  }
  const edges = [...span.values()].flatMap((s) => [[s.a, 1], [s.b + 1, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let live = 0;
  let armed = true;
  for (const [t, d] of edges) {
    live += d;
    if (live >= DELEGATION.swarmConcurrent && armed) {
      armed = false;
      add("swarm", t, `${live} subagents were running at the same time.`, { agents: live });
    }
    if (live === 0) armed = true;
  }

  // what Sparelimit said in this session: the same rule within 30 minutes is one moment
  const mine = auditSessionRows(auditRows, result.sessionId);
  for (const a of mine) add("sparelimit", a.t, `Sparelimit said: ${a.message}`, { rule: a.rule, count: a.count });

  moments.sort((a, b) => a.t - b.t || a.n - b.n);
  moments.forEach((m, i) => (m.id = i + 1));

  // long pauses, drawn as bands
  const gaps = [];
  for (let i = 1; i < main.length; i++) {
    const g = (main[i].t - main[i - 1].t) / MIN;
    if (g >= TIMELINE.awayMinutes) gaps.push({ afterN: main[i - 1].n, minutes: Math.round(g) });
  }

  // what the high-context stretch cost
  const high = main.filter((p) => p.pct != null && p.pct >= warn);
  const highUSD = high.reduce((n, p) => n + p.cost, 0);
  const total = all.reduce((n, e) => n + e.cost, 0);
  const counts = moments.reduce((m, x) => ((m[x.kind] = (m[x.kind] || 0) + 1), m), {});
  return {
    sessionId: result.sessionId,
    project: result.project ? projectLabel(String(result.project).split(/[\\/]/).pop()) : null, // the folder name, not the full local path
    start: result.start,
    end: result.end,
    responses: main.length,
    totalUSD: r2(total),
    windowTokens: result.contextWindowTokens,
    thresholds: { warnPct: warn, stopPct: block },
    points: main.map(({ n, t, pct, ctx, cumUSD, cost }) => ({ n, t, pct, ctx, cumUSD, cost })),
    moments,
    gaps,
    summary: {
      counts,
      aboveWarn: { responses: high.length, shareOfResponses: main.length ? Math.round((high.length / main.length) * 1000) / 10 : 0, usd: r2(highUSD), shareOfSpend: total ? Math.round((highUSD / total) * 1000) / 10 : 0, confidence: "derived" },
      earlierReset: result.earlierReset ? { savingUSD: result.earlierReset.savingUSD, lowUSD: result.earlierReset.savingLowUSD, highUSD: result.earlierReset.savingHighUSD, confidence: "estimated" } : null,
      activeMinutes: result.durationMin,
      calendarDays: result.spanDays
    },
    confidence: "derived"
  };
}
