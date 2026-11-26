/**
 * Delegation advisor (coach lever K3): when does handing work to a subagent pay, and when is a swarm not worth it?
 *
 * Measured from the logs (derived): every subagent's cost, the context it started with, the size of the answer it handed back to
 * the main conversation, and how many ran at the same time. Estimated: what a verbose tool output would have cost if a subagent had
 * read it and returned a short answer instead (the subagent's own cost is the median of this user's measured subagents).
 */
const CHARS_PER_TOKEN = 3.7;
const M = 1e6;

export const DELEGATION = { verboseTokens: 5_000, answerTokens: 1_000, swarmConcurrent: 4, swarmAgents: 8, materialShare: 0.1, heavyShare: 0.4, lightResponses: 3 };

const median = (/** @type {number[]} */ a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : 0);
const r2 = (/** @type {number} */ n) => Number(n.toFixed(2));

/** Per-subagent facts and the session's fan-out verdict. `priced` = [{ ev, cost }] sorted by time, sidechain events included. */
/** @param {any[]} priced @param {number} totalCost */
export function fanOutReport(priced, totalCost) {
  const answerChars = new Map(); // Task/Agent call id -> size of the answer returned to the caller
  for (const x of priced) for (const c of x.ev.calls || []) if (c.id && c.resChars != null) answerChars.set(c.id, c.resChars);
  /** @type {Map<string, any[]>} */
  const byAgent = new Map();
  for (const x of priced) if (x.ev.agentId) /** @type {any[]} */ (byAgent.get(x.ev.agentId) || byAgent.set(x.ev.agentId, []).get(x.ev.agentId)).push(x);
  const agents = [...byAgent.entries()].map(([id, list]) => {
    const t = list.map((x) => new Date(x.ev.ts).getTime());
    const chars = answerChars.get(list[0].ev.agentToolUseId);
    return {
      id,
      type: list[0].ev.agentType || "unknown",
      model: list[0].ev.model,
      responses: list.length,
      costUSD: r2(list.reduce((n, x) => n + x.cost, 0)),
      startContextTokens: list[0].ev.context,
      peakContextTokens: Math.max(...list.map((x) => x.ev.context)),
      answerTokens: chars != null ? Math.round(chars / CHARS_PER_TOKEN) : null,
      start: Math.min(...t),
      end: Math.max(...t)
    };
  });
  // most subagents running at the same moment
  const edges = agents.flatMap((a) => [[a.start, 1], [a.end + 1, -1]]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let live = 0;
  let peak = 0;
  for (const [, d] of edges) peak = Math.max(peak, (live += d));
  const sideUSD = agents.reduce((n, a) => n + a.costUSD, 0);
  const share = totalCost ? sideUSD / totalCost : 0;
  // swarm = many agents at once or in total AND a material part of the session's spend; heavy = subagents are most of the bill; otherwise ok
  let verdict = "none";
  if (agents.length) {
    const wide = peak >= DELEGATION.swarmConcurrent || agents.length >= DELEGATION.swarmAgents;
    verdict = wide && share >= DELEGATION.materialShare ? "swarm" : share >= DELEGATION.heavyShare ? "heavy" : "ok";
  }
  const light = agents.filter((a) => a.responses <= DELEGATION.lightResponses); // made only a few calls: most of what they cost was starting up
  return { agents: agents.length, peakConcurrent: peak, sideUSD: r2(sideUSD), shareOfSession: Number(share.toFixed(3)), lightAgents: light.length, lightUSD: r2(light.reduce((n, a) => n + a.costUSD, 0)), verdict, details: agents.map(({ start, end, ...a }) => a) };
}

/** Big tool outputs kept in the main conversation: [{ tool, tokens, carryUSD }] (carryUSD = written once, then re-read until compaction). */
export const isVerbose = (/** @type {number} */ tokens) => tokens >= DELEGATION.verboseTokens;

/**
 * What delegating a session's verbose outputs to ONE subagent would have saved: their carrying cost, less a short answer in their
 * place, less one subagent's measured median cost. Never negative: when it does not pay, the answer is 0.
 */
/** @param {{ carryUSD: number, tokens: number }[]} verbose @param {number} agentCostUSD */
export function verboseSavings(verbose, agentCostUSD) {
  if (!verbose.length) return { outputs: 0, carryUSD: 0, netSavingUSD: 0 };
  const carry = verbose.reduce((n, v) => n + v.carryUSD, 0);
  const kept = verbose.reduce((n, v) => n + (v.carryUSD * DELEGATION.answerTokens) / v.tokens, 0); // a short answer is carried instead
  return { outputs: verbose.length, carryUSD: r2(carry), netSavingUSD: r2(Math.max(0, carry - kept - agentCostUSD)) };
}

export { median, M };
