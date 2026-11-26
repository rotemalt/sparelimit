/**
 * Background-drain finder (K9): spend on work that began without you typing. Each main-thread response is tagged with what started its
 * stretch of work (see `triggerOf` in the Claude Code adapter): you ("typed"), a finished background task, a Stop hook asking the agent
 * to carry on (this includes /goal), a continuation prompt after a cut-off or a compaction, or something else
 * the app injected. Everything but "typed" is a drain in the sense of "you did not ask for this turn", NOT in the sense of "wasted": a
 * background task you launched is work you wanted. So the figures say where unprompted spend came from and let you judge.
 *
 * Not measured, because the logs do not show it: the idle-time compaction and the recap that Claude Code may run on its own (they do not
 * appear as responses in the session log), and scheduled tasks that run in a session of their own (those show up as ordinary sessions).
 */
export const DRAIN_LABELS = {
  "background-task": "Replies to finished background tasks",
  "stop-hook": "Stop hooks and /goal asking the agent to carry on",
  continuation: "Continuations after a cut-off or a compaction",
  other: "Other app-injected prompts"
};

/** @param {{ byTriggerUSD?: Record<string, { responses: number, usd: number, sessions: number }>, totalCostUSD?: number }} summary */
export function buildDrains(summary) {
  const by = summary.byTriggerUSD || {};
  const total = summary.totalCostUSD || Object.values(by).reduce((n, v) => n + v.usd, 0);
  const rows = Object.entries(DRAIN_LABELS)
    .filter(([k]) => by[k]?.usd > 0)
    .map(([k, label]) => ({ id: k, label, usd: by[k].usd, responses: by[k].responses, sessions: by[k].sessions, shareOfSpend: total ? Math.round((by[k].usd / total) * 1000) / 10 : 0 }))
    .sort((a, b) => b.usd - a.usd);
  const typed = by.typed?.usd || 0;
  return {
    rows,
    unpromptedUSD: Math.round(rows.reduce((n, r) => n + r.usd, 0) * 100) / 100,
    typedUSD: typed,
    confidence: "derived",
    note: "Spend on turns you did not type, by what started them (main thread only; subagents are in `sparelimit delegate`). That is where the spend came from, not a verdict that it was wasted: a background task you launched is work you wanted. The idle-time compaction and recap Claude Code may run by itself do not appear in the session log, so they are not here."
  };
}
