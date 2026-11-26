import path from "node:path";

/**
 * Rework detectors (C3), derived from the tool calls in a log. Two patterns, each with the dollars of the responses that carried the repeats:
 *   - rewrite loop: the same file edited REWORK.minEdits or more times, each edit within REWORK.gapResponses main-thread responses of the
 *     one before. The first edit is the work; the later ones are the loop.
 *   - failing repeat: the exact same command (same name and input) that came back as an error REWORK.minFails or more times in a session.
 *     The first failure is information; the later ones are the loop.
 * The dollars are the cost of the responses that made the repeated calls (a response with several calls is shared between them). That is
 * what the repeats rode on, not a saving: some of those edits were needed. It is derived (arithmetic on the log), and says so.
 */
export const REWORK = { minEdits: 4, gapResponses: 25, minFails: 3 };
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/**
 * @param {{ cost: number, ev: { isSidechain?: boolean, calls?: { name: string, sig: string, res?: string, file?: string }[] } }[]} priced
 * @returns {{ rewriteLoops: { file: string, edits: number, spanResponses: number, costUSD: number }[], failingRepeats: { tool: string, times: number, costUSD: number }[], rewriteLoopUSD: number, failingRepeatUSD: number, confidence: string }}
 */
export function findRework(priced) {
  /** @type {Map<string, { pos: number, share: number }[]>} */
  const edits = new Map();
  /** @type {Map<string, { tool: string, hits: number[] }>} */
  const fails = new Map();
  /** @type {number[]} */
  const shares = [];
  let main = -1;
  for (const x of priced) {
    if (x.ev.isSidechain) continue;
    main += 1;
    const calls = x.ev.calls || [];
    const share = calls.length ? x.cost / calls.length : 0;
    for (const c of calls) {
      if (EDIT_TOOLS.has(c.name) && c.file) {
        const list = edits.get(c.file) || [];
        list.push({ pos: main, share });
        edits.set(c.file, list);
      }
      if (c.res?.startsWith("!")) {
        const f = fails.get(c.sig) || { tool: c.name, hits: [] };
        f.hits.push(shares.length);
        fails.set(c.sig, f);
      }
      shares.push(share);
    }
  }
  /** @type {{ file: string, edits: number, spanResponses: number, costUSD: number }[]} */
  const rewriteLoops = [];
  for (const [file, list] of edits) {
    let start = 0;
    for (let i = 1; i <= list.length; i++) {
      if (i < list.length && list[i].pos - list[i - 1].pos <= REWORK.gapResponses) continue;
      const run = list.slice(start, i);
      if (run.length >= REWORK.minEdits) rewriteLoops.push({ file: path.basename(file), edits: run.length, spanResponses: run[run.length - 1].pos - run[0].pos + 1, costUSD: round(run.slice(1).reduce((n, e) => n + e.share, 0)) });
      start = i;
    }
  }
  /** @type {{ tool: string, times: number, costUSD: number }[]} */
  const failingRepeats = [];
  for (const f of fails.values()) if (f.hits.length >= REWORK.minFails) failingRepeats.push({ tool: f.tool, times: f.hits.length, costUSD: round(f.hits.slice(1).reduce((n, i) => n + shares[i], 0)) });
  rewriteLoops.sort((a, b) => b.costUSD - a.costUSD);
  failingRepeats.sort((a, b) => b.costUSD - a.costUSD);
  return { rewriteLoops, failingRepeats, rewriteLoopUSD: round(rewriteLoops.reduce((n, l) => n + l.costUSD, 0)), failingRepeatUSD: round(failingRepeats.reduce((n, l) => n + l.costUSD, 0)), confidence: "derived" };
}

const round = (/** @type {number} */ n) => Math.round(n * 100) / 100;
