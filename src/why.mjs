/**
 * The why engine (X4): for one session, the causes that cost it the most, ranked, each with its dollars and its share of the session's
 * spend. Built only from a replay result, so every figure traces to `sparelimit replay`.
 *
 * Two kinds of rows, as on the "what to change" card, never mixed up:
 *   - "avoidable": a modelled change in behaviour (estimated: it assumes the change is made and the handoff is clean)
 *   - "at stake":  spend in an area (an upper bound on what could be saved there, not a saving)
 * The causes OVERLAP (a big context makes re-reads and cold returns dearer too), so they are never summed and no total is given.
 */
import { REWORK } from "./rework.mjs";

export const WHY = { minUSD: 0.01, minSharePct: 1 };

const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;
const usd = (/** @type {number} */ n) => `$${n.toFixed(2)}`;

/** @param {any} result a replay result */
export function buildWhy(result) {
  const total = result.totalCostUSD || 0;
  /** @type {{ id: string, kind: string, title: string, usd: number, sharePct: number, confidence: string, detail: string, fix: string }[]} */
  const causes = [];
  const add = (/** @type {string} */ id, /** @type {string} */ kind, /** @type {string} */ title, /** @type {number | null | undefined} */ amount, /** @type {string} */ confidence, /** @type {string} */ detail, /** @type {string} */ fix) => {
    if (amount == null || !(amount >= WHY.minUSD) || !total) return;
    const sharePct = Math.round((amount / total) * 1000) / 10;
    if (sharePct < WHY.minSharePct) return;
    causes.push({ id, kind, title, usd: r2(amount), sharePct, confidence, detail, fix });
  };

  const er = result.earlierReset;
  if (er && er.savingUSD > 0) {
    add("context.oversized", "avoidable", "The conversation grew large before it was reset", er.savingUSD, "estimated",
      `Starting fresh at 60% of the window instead of letting it grow (range ${usd(er.savingLowUSD)} to ${usd(er.savingHighUSD)}).`,
      "Run /compact or start a fresh conversation near 60%, with a short handoff.");
  }
  const b = result.breaks;
  if (b && b.over60min > 0) {
    add("cache.cold", "at stake", "Coming back after the cache had expired", b.extraVsWarmUSD, "derived",
      `${b.over60min} return${b.over60min === 1 ? "" : "s"} after more than an hour re-processed the whole conversation, ${usd(b.extraVsWarmUSD)} more than a warm cache.`,
      "Before a long break, finish or hand off the task, or start the next one fresh.");
  }
  const loop = result.avoidable?.repeatedCallsUSD;
  add("loop.repeat", "avoidable", "The same call repeated with the same result", loop, "derived",
    `Spend on responses that repeated a call the loop rules had already flagged (${usd(loop || 0)}).`,
    "Stop, change the approach, or give the agent the missing information.");
  const rr = result.reads;
  if (rr && rr.identicalRepeats > 0) {
    add("reads.repeat", "at stake", "Files read again with nothing changed", rr.identicalRepeatsCarryUSD, "estimated",
      `${rr.identicalRepeats} of ${rr.total} reads returned exactly what an earlier read had; each stayed in the conversation and was paid for on every later response.`,
      "Tell the agent the file is already in context, or ask for the lines it needs.");
  }
  const rw = result.rework;
  if (rw?.rewriteLoops?.length) {
    const top = rw.rewriteLoops[0];
    add("rework.edits", "at stake", "The same file edited again and again", rw.rewriteLoopUSD, "derived",
      `${rw.rewriteLoops.length} file${rw.rewriteLoops.length > 1 ? "s were" : " was"} edited ${REWORK.minEdits}+ times in a row of nearby responses; the worst, ${top.file}, ${top.edits} times over ${top.spanResponses} responses. The dollars are the responses that made the later edits, not a saving: some were needed.`,
      "When the same file keeps changing, stop and say what is wrong with it, or give the agent the failing output, instead of letting it keep trying.");
  }
  if (rw?.failingRepeats?.length) {
    const top = rw.failingRepeats[0];
    add("rework.failing", "at stake", "The same failing command run again", rw.failingRepeatUSD, "derived",
      `${rw.failingRepeats.length} command${rw.failingRepeats.length > 1 ? "s" : ""} failed ${REWORK.minFails}+ times with identical input; the worst (${top.tool}) ${top.times} times. The dollars are the responses that ran it again after the first failure.`,
      "After a failure, change something before running it again: read the error, fix the cause, or ask for help.");
  }
  const d = result.delegation;
  if (d && d.agents > 0) {
    add("subagents", "at stake", `Subagents (${d.agents}, up to ${d.peakConcurrent} at once)`, d.sideUSD, "derived",
      `${d.verdict === "swarm" ? "A swarm. " : d.verdict === "heavy" ? "Most of the bill. " : ""}${d.lightAgents} made only a few calls, which is mostly start-up cost (${usd(d.lightUSD || 0)}).`,
      "Hand a subagent only verbose, single-shot work; avoid many small parallel jobs.");
  }
  const sb = result.spendBreakdown;
  if (sb) {
    add("context.start", "at stake", "The fixed starting context, re-read on every response", sb.startContextUSD, "derived",
      `About ${Math.round(sb.startContextTokens / 1000)}k tokens (system prompt, tools, memory, skills) before you type anything.`,
      "Trim what `sparelimit setup` lists as largest: unused MCP servers, long memory files.");
  }
  /** @type {{ carryUSD: number, tokens: number }[]} */
  const verbose = result.delegation?.verbose || [];
  const vUSD = verbose.reduce((n, v) => n + v.carryUSD, 0);
  if (verbose.length) {
    add("tool.output", "at stake", "Large tool outputs kept in the conversation", vUSD, "estimated",
      `${verbose.length} outputs of ${Math.round(Math.min(...verbose.map((v) => v.tokens)) / 1000)}k tokens or more, each re-read until the conversation was compacted.`,
      "Filter before reading (grep, head, line ranges) or hand verbose work to a subagent.");
  }

  causes.sort((a, c) => c.usd - a.usd);
  return {
    sessionId: result.sessionId,
    totalUSD: r2(total),
    causes,
    note: "The causes overlap, so they are not added up. Avoidable rows are modelled (estimated); at-stake rows are spend in an area, an upper bound on what could be saved there."
  };
}
