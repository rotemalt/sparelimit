/**
 * Hard-stop policy engine. Pure: takes a snapshot of the session and returns what to do.
 * Ladder: allow → warn → block. A `null` threshold disables that check.
 */
import { windowOutlook, FIVE_HOURS, SEVEN_DAYS } from "./rates.mjs";

/**
 * @typedef {{ sessionWarnUSD: number | null, sessionBlockUSD: number | null, hourlyWarnUSD: number | null, hourlyBlockUSD: number | null }} BudgetPolicy
 * @typedef {{ warnPct: number | null, blockPct: number | null }} ContextPolicy
 * @typedef {{ weeklyPaceMarginPts: number | null, fiveHourWarnPct: number | null, fiveHourBlockPct: number | null, sevenDayWarnPct: number | null, sevenDayBlockPct: number | null, projectionWarn: boolean, blockOnEstimated: boolean }} QuotaPolicy
 * @typedef {{ warnAfter: number | null, blockAfter: number | null, windowWarn: number | null, windowBlock: number | null, noProgressWarn: number | null, noProgressBlock: number | null, failWarn: number | null, failBlock: number | null }} LoopPolicy
 * @typedef {{ budget: BudgetPolicy, context: ContextPolicy, quota: QuotaPolicy, loop: LoopPolicy }} Policy
 * @typedef {{ preset?: string, budget?: Partial<BudgetPolicy>, context?: Partial<ContextPolicy>, quota?: Partial<QuotaPolicy>, loop?: Partial<LoopPolicy> }} UserPolicy
 * @typedef {{ pct: number | null, resetsAt?: number | null }} QuotaWindow
 * @typedef {{ costUsd?: number | null, contextPct?: number | null, contextTokens?: number | null, rateLimits?: { fiveHour?: QuotaWindow | null, sevenDay?: QuotaWindow | null }, burn?: { fiveHourPctPerHour?: number | null, costPerHourUSD?: number | null, spanMin?: number | null }, quotaEstimated?: boolean, [k: string]: any }} PolicySnapshot
 * @typedef {{ rule: string, level: "warn" | "block", message: string, evidence?: any }} Finding
 */

/** @type {Policy} */
export const DEFAULT_POLICY = {
  budget: { sessionWarnUSD: 20, sessionBlockUSD: null, hourlyWarnUSD: null, hourlyBlockUSD: null }, // replay on 93 real sessions: $8/$25 session caps fired on almost every long session
  context: { warnPct: 60, blockPct: 95 },
  quota: { weeklyPaceMarginPts: null, fiveHourWarnPct: 80, fiveHourBlockPct: 95, sevenDayWarnPct: 85, sevenDayBlockPct: 97, projectionWarn: true, blockOnEstimated: false }, // blockOnEstimated: let estimates from logs (not exact app numbers) block, not just warn
  loop: { warnAfter: 4, blockAfter: 8, windowWarn: null, windowBlock: null, noProgressWarn: 4, noProgressBlock: 8, failWarn: 3, failBlock: null } // failWarn/failBlock: the same call has FAILED this many times (needs the post-tool hooks, `sparelimit init --post-hooks`); identical consecutive calls; same-call-in-window is off (screenshots and reads repeat legitimately); no-progress = same call AND same result
};

/**
 * Presets (R4): named sets of thresholds. They are STARTING POINTS, not measured optima: the numbers are round figures chosen for a
 * kind of day, so tune them against `sparelimit replay` on your own sessions. Your own values always win over a preset.
 *   agency-day   a ceiling on the pace of spending, for a day of billable work: warn at $10 an hour, stop at $30
 *   weekly-pace  warn when the weekly quota is used 7 points faster than the week has gone (day 3 of 7 is 43%, so more than 50%)
 *   steady       both of the above, and the context warning at 50%
 */
export const PRESETS = {
  "agency-day": { budget: { hourlyWarnUSD: 10, hourlyBlockUSD: 30 } },
  "weekly-pace": { quota: { weeklyPaceMarginPts: 7 } },
  steady: { budget: { hourlyWarnUSD: 10, hourlyBlockUSD: 30 }, quota: { weeklyPaceMarginPts: 7 }, context: { warnPct: 50 } }
};

/** @param {UserPolicy} [user] @returns {Policy} */
export function mergePolicy(user = {}) {
  /** @type {UserPolicy} */
  const preset = (user.preset && /** @type {Record<string, UserPolicy>} */ (PRESETS)[user.preset]) || {};
  /** @type {any} */
  const out = {};
  for (const k of /** @type {(keyof Policy)[]} */ (Object.keys(DEFAULT_POLICY))) out[k] = { ...DEFAULT_POLICY[k], ...(preset[k] || {}), ...(user[k] || {}) };
  return out;
}

/**
 * What to do next (X5), one line per rule that does not already say it. Plain advice, not a measured effect: whether it helps depends on the
 * work. The rules about the context window, session cost and loops carry their own advice in the message.
 */
/** @type {Record<string, string>} */
export const SUGGESTIONS = {
  "quota.five_hour": "Slow down, run routine work on Sonnet, or wait for the reset; `sparelimit plan --accounts` shows whether another account has headroom.",
  "quota.projection": "At this pace, slow down, move routine work to Sonnet, or hand off with `sparelimit reset` once the window resets.",
  "quota.seven_day": "Spread the heavy work over the days left and run routine work on Sonnet; `sparelimit plan` shows the forecast.",
  "quota.seven_day_projection": "Spread the heavy work over the days left, run routine work on Sonnet, or check `sparelimit plan --accounts` for an account with headroom.",
  "quota.weekly_pace": "Even out the week: keep the big sessions for when they matter and run routine work on Sonnet.",
  "budget.hourly": "Slow down: batch the requests, or hand off to a fresh session with `sparelimit reset` if the conversation is large."
};

/** @param {number} value @param {number | null} warn @param {number | null} block @returns {"warn" | "block" | null} */
const level = (value, warn, block) => (block != null && value >= block ? "block" : warn != null && value >= warn ? "warn" : null);

/**
 * @param {object} p
 * @param {PolicySnapshot} [p.snapshot]  collector snapshot (see collector.mjs); fields may be missing
 * @param {{count:number, tool:string, windowCount?:number, noProgress?:number, failCount?:number}} [p.loop] consecutive identical tool calls
 * @param {UserPolicy} [p.policy]  user policy, merged over defaults
 * @param {number} [p.now]     ms epoch
 * @param {number} [p.overrideUntil] ms epoch; while active, blocks are downgraded to warnings
 */
export function evaluate({ snapshot = {}, loop, policy, now = Date.now(), overrideUntil = 0 }) {
  const cfg = mergePolicy(policy);
  /** @type {Finding[]} */
  const findings = [];
  const add = (/** @type {string} */ rule, /** @type {"warn" | "block" | null} */ lvl, /** @type {string} */ message, /** @type {any} */ evidence) => lvl && findings.push({ rule, level: lvl, message: SUGGESTIONS[rule] ? `${message} ${SUGGESTIONS[rule]}` : message, evidence });

  if (snapshot.costUsd != null) {
    const l = level(snapshot.costUsd, cfg.budget.sessionWarnUSD, cfg.budget.sessionBlockUSD);
    add("budget.session", l, `Session cost is $${snapshot.costUsd.toFixed(2)} (limit ${l === "block" ? "$" + cfg.budget.sessionBlockUSD : "warning at $" + cfg.budget.sessionWarnUSD}). Hand off to a fresh session with \`sparelimit reset\`.`, { costUsd: snapshot.costUsd });
  }

  if (snapshot.contextPct != null) {
    const l = level(snapshot.contextPct, cfg.context.warnPct, cfg.context.blockPct);
    add("context.window", l, `Context window is ${Math.round(snapshot.contextPct)}% full — every turn re-sends it. Run \`sparelimit reset\` and continue in a fresh session.`, { contextPct: snapshot.contextPct, contextTokens: snapshot.contextTokens });
  }

  const rl = snapshot.rateLimits || {};
  const fh = rl.fiveHour;
  if (fh?.pct != null) {
    const resetMin = fh.resetsAt ? Math.max(0, Math.round((fh.resetsAt * 1000 - now) / 60000)) : null;
    const l = level(fh.pct, cfg.quota.fiveHourWarnPct, cfg.quota.fiveHourBlockPct);
    add("quota.five_hour", l, `5-hour quota is ${Math.round(fh.pct)}% used${resetMin != null ? `; resets in ${resetMin} min` : ""}.`, { pct: fh.pct, resetMin });
    // Burn-rate projection: will the window run out before it resets? Prefer the recent rate (last ~30 min).
    if (cfg.quota.projectionWarn && !l) {
      const o = windowOutlook(fh, { ratePctPerHour: snapshot.burn?.fiveHourPctPerHour ?? null, windowMs: FIVE_HOURS, now });
      if (o && fh.pct >= 20 && o.minutesToLimit != null && o.lastsUntilReset === false)
        add("quota.projection", "warn", `Burning ~${o.ratePctPerHour}%/h of the 5-hour quota (${o.basis}): it runs out in ~${o.minutesToLimit} min, ${Math.max(0, o.resetsInMin - o.minutesToLimit)} min before it resets.`, { pct: fh.pct, ratePctPerHour: o.ratePctPerHour, minToFull: o.minutesToLimit });
    }
  }
  const sd = rl.sevenDay;
  if (sd?.pct != null) {
    const l = level(sd.pct, cfg.quota.sevenDayWarnPct, cfg.quota.sevenDayBlockPct);
    add("quota.seven_day", l, `Weekly quota is ${Math.round(sd.pct)}% used.`, { pct: sd.pct });
    if (cfg.quota.projectionWarn && !l && sd.pct >= 20) {
      const o = windowOutlook(sd, { ratePctPerHour: null, windowMs: SEVEN_DAYS, now });
      if (o && o.minutesToLimit != null && o.lastsUntilReset === false && o.resetsInMin > 12 * 60)
        add("quota.seven_day_projection", "warn", `At this week's pace (${o.ratePctPerHour}%/h) the weekly quota runs out in ~${Math.round(o.minutesToLimit / 60)} h, ${Math.round((o.resetsInMin - o.minutesToLimit) / 60)} h before it resets.`, { pct: sd.pct, ratePctPerHour: o.ratePctPerHour });
    }
  }

  // weekly pace (R4): the weekly quota used faster than the week has gone
  if (sd?.pct != null && sd.resetsAt && cfg.quota.weeklyPaceMarginPts != null) {
    const elapsedPct = Math.max(0, Math.min(100, (1 - (sd.resetsAt * 1000 - now) / SEVEN_DAYS) * 100));
    if (elapsedPct >= 100 / 7 && sd.pct - elapsedPct >= cfg.quota.weeklyPaceMarginPts)
      add("quota.weekly_pace", "warn", `The weekly quota is ${Math.round(sd.pct)}% used with ${Math.round(elapsedPct)}% of the week gone: ahead of an even pace by ${Math.round(sd.pct - elapsedPct)} points.`, { pct: sd.pct, elapsedPct: Math.round(elapsedPct) });
  }

  if (snapshot.burn?.costPerHourUSD != null) {
    const l = level(snapshot.burn.costPerHourUSD, cfg.budget.hourlyWarnUSD, cfg.budget.hourlyBlockUSD);
    add("budget.hourly", l, `Spending $${snapshot.burn.costPerHourUSD}/h over the last ${snapshot.burn.spanMin} min (limit ${l === "block" ? "$" + cfg.budget.hourlyBlockUSD : "warning at $" + cfg.budget.hourlyWarnUSD}/h).`, { costPerHourUSD: snapshot.burn.costPerHourUSD });
  }

  if (loop && loop.count > 1) {
    const l = level(loop.count, cfg.loop.warnAfter, cfg.loop.blockAfter);
    add("loop.identical_calls", l, `${loop.tool} was called ${loop.count} times in a row with identical input. Stop and re-plan instead of repeating it.`, { tool: loop.tool, count: loop.count });
  }

  const windowCount = loop?.windowCount ?? 0;
  if (loop && windowCount > 1) {
    const l = level(windowCount, cfg.loop.windowWarn, cfg.loop.windowBlock);
    add("loop.repeats_in_window", l, `${loop.tool} with the same input ran ${windowCount} times in the last 20 calls. Stop and change approach instead of repeating it.`, { tool: loop.tool, windowCount });
  }

  const failCount = loop?.failCount ?? 0;
  if (loop && failCount > 1) {
    const l = level(failCount, cfg.loop.failWarn, cfg.loop.failBlock);
    add("loop.failing_repeat", l, `${loop.tool} has failed ${failCount} times with identical input. Read the error and change something before running it again, or ask for help.`, { tool: loop.tool, failCount });
  }

  const noProgress = loop?.noProgress ?? 0;
  if (loop && noProgress > 1) {
    const l = level(noProgress, cfg.loop.noProgressWarn, cfg.loop.noProgressBlock);
    add("loop.no_progress", l, `${loop.tool} gave the same result ${noProgress} times in the last 20 calls. Nothing is changing: stop and try a different approach.`, { tool: loop.tool, noProgress });
  }

  // Numbers estimated from logs (not reported by the app) say so, and only warn unless the user opts in to blocking on them.
  if (snapshot.quotaEstimated) {
    for (const f of findings) {
      if (!f.rule.startsWith("quota.")) continue;
      f.message += " (estimated from your logs)";
      if (f.level === "block" && !cfg.quota.blockOnEstimated) f.level = "warn";
    }
  }

  let worst = findings.some((f) => f.level === "block") ? "block" : findings.length ? "warn" : "allow";
  let overridden = false;
  if (worst === "block" && overrideUntil > now) {
    worst = "warn";
    overridden = true;
    for (const f of findings) if (f.level === "block") f.level = "warn";
  }
  return { level: worst, findings, overridden };
}
