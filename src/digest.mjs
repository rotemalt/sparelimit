import { summarize } from "./replay.mjs";
import { buildHabitCard } from "./habits.mjs";

/**
 * Weekly digest (coach K10): the last 7 days against the 7 before, what cost the most, and one habit to work on.
 *   - spend comes from per-response timestamps (derived), so a session that spans two weeks is split correctly
 *   - the habit figures come from the sessions that ENDED in the week, whole-session (so they can include earlier days); estimated
 *   - nudges are what Sparelimit's coach actually showed (audit log): the start of adoption tracking (K11)
 * Pure: pass in the events, the replay results, the audit rows and "now".
 */
const DAY = 86400e3;
const r2 = (/** @type {number} */ n) => Number(n.toFixed(2));

/**
 * @param {{ events?: any[], results?: any[], auditRows?: any[], now?: number, weeklyLimitUSD?: number | null, adoption?: any, ledger?: any }} p
 */
export function buildDigest({ events = [], results = [], auditRows = [], now = Date.now(), weeklyLimitUSD = null, adoption = null, ledger = null }) {
  const sum = (/** @type {any} */ a, /** @type {any} */ b) => events.filter((e) => e.t > a && e.t <= b).reduce((n, e) => n + e.cost, 0);
  const thisWeek = sum(now - 7 * DAY, now);
  const lastWeek = sum(now - 14 * DAY, now - 7 * DAY);
  /** @type {Record<string, number>} */
  const perDay = {};
  for (const e of events) if (e.t > now - 7 * DAY && e.t <= now) perDay[new Date(e.t).toISOString().slice(0, 10)] = (perDay[new Date(e.t).toISOString().slice(0, 10)] || 0) + e.cost;
  const busiest = Object.entries(perDay).sort((a, b) => b[1] - a[1])[0] || null;

  const ended = results.filter((r) => Date.parse(r.end) > now - 7 * DAY && Date.parse(r.end) <= now);
  const summary = summarize(ended);
  const card = ended.length ? buildHabitCard({ ...summary, firstStart: new Date(now - 7 * DAY).toISOString(), lastEnd: new Date(now).toISOString() }, { weeklyLimitUSD }) : null;
  // the focus is the biggest habit we can stand behind: rows with a quality caution (the model downshift) only if nothing else is left
  const focus = card?.savings.find((h) => h.usd > 0 && !h.caution) || card?.savings.find((h) => h.usd > 0) || null;

  /** @type {Record<string, number>} */
  const nudges = {};
  for (const row of auditRows) if (row.kind === "coach" && Date.parse(row.t) > now - 7 * DAY && Date.parse(row.t) <= now) nudges[row.rule] = (nudges[row.rule] || 0) + 1;

  return {
    period: { from: new Date(now - 7 * DAY).toISOString(), to: new Date(now).toISOString() },
    spend: {
      thisWeekUSD: r2(thisWeek),
      lastWeekUSD: r2(lastWeek),
      changePct: lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : null,
      weeklyLimitPct: weeklyLimitUSD ? Math.round((thisWeek / weeklyLimitUSD) * 100) : null,
      busiestDay: busiest ? { date: busiest[0], usd: r2(busiest[1]) } : null,
      confidence: "derived"
    },
    sessionsEnded: ended.length,
    swarms: ended.filter((r) => r.delegation.verdict === "swarm").map((r) => ({ sessionId: r.sessionId, agents: r.delegation.agents, peakConcurrent: r.delegation.peakConcurrent, sideUSD: r.delegation.sideUSD, totalUSD: r.totalCostUSD })),
    breaks: { times: summary.breaks?.messages || 0, extraVsWarmUSD: summary.breaks?.extraVsWarmUSD || 0 },
    habits: card ? { savings: card.savings, atStake: card.atStake } : null,
    focus: focus && { id: focus.id, title: focus.title, usd: focus.usd, how: focus.how, confidence: focus.confidence },
    nudges,
    ledger: ledger ? { ...ledger.totals } : null, // the savings ledger for the week (X1; see src/ledger.mjs)
    // habits with a start date (declared, or the first coach nudge): did the behaviour move? (K11; see src/adoption.mjs)
    adoption: (adoption?.habits || []).filter((/** @type {any} */ h) => h.start).map((/** @type {any} */ h) => ({ id: h.id, title: h.title, start: h.start, verdict: h.verdict, reason: h.reason, changePct: h.changePct, unit: h.unit })),
    note: "Spend is per response (derived). Habit figures are whole sessions that ended this week and are estimates; they overlap and are not additive."
  };
}
