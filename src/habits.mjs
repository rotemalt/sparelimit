/**
 * "What to change" card (coach K10): the habits that cost this user the most, ranked by measured dollars, with the share of spend
 * and what that is in plan-limit terms. Built only from a replay summary, so every figure traces to `sparelimit replay`.
 *
 * Two kinds of rows, never mixed up:
 *   - "saving":   a modelled change in behaviour (estimated: it assumes the change is made and the handoff is clean)
 *   - "at stake": spend in an area (derived from the log). It is an upper bound on what a habit could save, not a saving.
 * The savings OVERLAP (a conversation reset early cannot also be resumed cold), so they are never summed.
 */
const r2 = (/** @type {number} */ n) => Number(n.toFixed(2));

/**
 * The model lever. With the model advisor's data: the low-risk work (running commands, exploring, driving tools) priced one tier
 * down, with the range from "half of it" to "low and medium risk together", and the user's own failure rates as (confounded) evidence.
 * Without it (older summaries): half of the Opus work on Sonnet.
 */
function modelRow(/** @type {any} */ summary, /** @type {any} */ row) {
  const m = summary.models;
  const caution = "this is the least certain row: it trades quality for price, quality is not measured here, and a plan limit may weigh models differently than list prices do.";
  if (!m?.rows?.length) return row("model-mix", "saving", "Run half of the Opus work on Sonnet", summary.opusHalfToSonnetUSD, "estimated", "Use Sonnet for routine edits and Opus for hard reasoning (/model). Quality trade-off: check the results.", { opusUSD: summary.byModelUSD.opus, caution });
  const evid = m.evidence.map((/** @type {any} */ e) => `${e.type === "run" ? "commands" : "edits"} failed ${e.sonnet.failedPct}% on Sonnet vs ${e.opus.failedPct}% on Opus`).join("; ");
  return row("model-low-risk", "saving", "Run low-risk work (commands, exploring, driving tools) on Sonnet instead of Opus", m.tierSavingUSD.low, "estimated", `Try one kind of work for a week and compare retries (/model). Run \`sparelimit models\` for the split.${evid ? ` In your history: ${evid} (not like for like).` : ""}`, { range: [Number((m.tierSavingUSD.low / 2).toFixed(2)), Number((m.tierSavingUSD.low + m.tierSavingUSD.medium).toFixed(2))], caution });
}

/** The "how" for subagents, from this user's own measured subagents. */
function subagentHow(/** @type {any} */ d) {
  if (!d?.agents) return "Hand a subagent only verbose, single-shot work (tests, logs, docs). Avoid swarms: they multiply the context.";
  const light = d.lightAgents ? ` ${d.lightAgents} of ${d.agents} made three calls or fewer: mostly start-up cost.` : "";
  return `Your ${d.agents} subagents cost a median $${d.medianAgentCostUSD.toFixed(2)} each, start with ~${Math.round(d.medianAgentStartTokens / 1000)}k tokens and hand back ~${d.medianAnswerTokens} tokens.${light} ${d.verdicts?.swarm || 0} sessions ran a swarm (${"$" + Math.round(d.swarmSpendUSD)}): use subagents for verbose, single-shot work, not for many small parallel jobs.`;
}

/**
 * @param {any} summary
 * @param {{ weeklyLimitUSD?: number | null }} [opts]
 */
export function buildHabitCard(summary, { weeklyLimitUSD = null } = {}) {
  const total = summary.totalCostUSD || 0;
  const spanMs = summary.firstStart && summary.lastEnd ? Date.parse(summary.lastEnd) - Date.parse(summary.firstStart) : 0;
  const weeks = Math.max(1, spanMs / (7 * 86400e3));
  const row = (/** @type {string} */ id, /** @type {any} */ kind, /** @type {string} */ title, /** @type {any} */ usd, /** @type {any} */ confidence, /** @type {any} */ how, extra = {}) => ({
    id,
    kind,
    title,
    usd: r2(usd),
    shareOfSpend: total ? Number(((usd / total) * 100).toFixed(1)) : 0,
    // average per calendar week over the period the logs cover, as a share of one weekly plan limit
    weeklyLimitPct: weeklyLimitUSD ? Number(((usd / weeks / weeklyLimitUSD) * 100).toFixed(0)) : null,
    confidence,
    how,
    ...extra
  });
  const er = summary.earlierReset;
  const br = summary.breaks;
  const savings = [
    row("reset-early", "saving", "Start fresh at ~60% of the window instead of waiting for auto-compaction", er.netSavingUSD, "estimated", "Finish the step, run `sparelimit reset`, /clear and paste the handoff (or /compact with a focus).", { range: [er.netSavingLowUSD, er.netSavingHighUSD], sessions: er.sessionsModelled }),
    row("no-cold-resume", "saving", "Do not resume a big conversation after a break; start fresh with a handoff", br.savingUSD, "estimated", "If you will be away over an hour, run `sparelimit reset` first. The break advisor tells you when it applies.", { times: br.messages, over60min: br.over60min }),
    ...(summary.delegation?.verboseNetSavingUSD > 0
      ? [row("delegate-verbose", "saving", "Hand very large tool outputs (5k+ tokens) to one subagent that returns a short answer", summary.delegation.verboseNetSavingUSD, "estimated", `Only for outputs worth the start-up: a subagent of yours costs about $${summary.delegation.medianAgentCostUSD.toFixed(2)} and starts with ~${Math.round(summary.delegation.medianAgentStartTokens / 1000)}k tokens. Pays in ${summary.delegation.sessionsWhereDelegatingPays} of your sessions; one subagent per session, not one per command.`, { outputs: summary.delegation.verboseOutputs })]
      : []),
    modelRow(summary, row)
  ].sort((a, b) => b.usd - a.usd);
  const carry = summary.toolOutputCarryUSD || {};
  const atStake = [
    row("start-context", "at-stake", "Fixed starting context (system prompt, tools, skills, memory) re-sent on every message", summary.spendBreakdownUSD.startContextUSD, "derived", "Run `sparelimit setup` and remove what you do not use (plugins, MCP servers, long CLAUDE.md files)."),
    row("subagents", "at-stake", "Side threads (subagents)", summary.sidechainUSD, "derived", subagentHow(summary.delegation), { swarmUSD: summary.delegation?.swarmSpendUSD ?? null }),
    row("file-reads", "at-stake", "Keeping file contents in the conversation after reading them", carry["Read"] || 0, "estimated", "Read by line range instead of whole files, and split files that are read whole again and again: `sparelimit files` lists the costliest."),
    row("rewrite-loops", "at-stake", "Files edited again and again in a row", summary.reworkUSD?.rewriteLoopUSD || 0, "derived", "When the same file keeps changing, stop and say what is wrong, or hand over the failing output. Some of these edits were needed: this is what the repeats rode on, not a saving. `sparelimit why` names the files."),
    row("failing-repeats", "at-stake", "The same failing command run again", summary.reworkUSD?.failingRepeatUSD || 0, "derived", "After a failure change something before running it again: read the error or fix the cause."),
    row("command-output", "at-stake", "Keeping command output in the conversation", carry["Command output"] || 0, "estimated", "Cap or filter long command output (tests, build logs) before it enters the conversation.")
  ].sort((a, b) => b.usd - a.usd);
  return {
    totalUSD: r2(total),
    sessions: summary.sessions,
    weeks: Number(weeks.toFixed(1)),
    savings,
    atStake,
    note: "Savings overlap and are not additive. 'At stake' rows are spend, not savings. The weekly-limit share compares an average week of your logs with one weekly plan limit estimated from your calibration."
  };
}
