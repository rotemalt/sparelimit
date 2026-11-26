import { REPLAY } from "./replay.mjs";

/**
 * Handoff quality, measured (X15). The earlier-reset model assumes `REPLAY.rebuildTokens` of context are re-read after a reset (the "files
 * read again" effect). This measures it on the shrinks that really happened in the logs (a /compact, an auto-compaction or a /clear
 * inside one session): in the 10 responses from the shrink on, the size of the Read results for files that had already been read earlier
 * in the session.
 *
 * Two wider measures sit beside it, because the Read tool is only one way to rebuild: the size of ALL tool output in those responses, and how
 * much the context grew over them (new work is in both, so they are upper bounds on the rebuild).
 *
 * It is a proxy, and labelled so: a compaction keeps a summary of the work, a fresh start with a short handoff keeps less, so a fresh
 * start probably re-reads more than this measures. Sizes are in characters (about 3.7 per token).
 */
export const REBUILD = { windowResponses: 10, minAfter: 10, charsPerToken: REPLAY.charsPerToken, minEvents: 10 };

/** @typedef {{ at: string, contextBefore: number, contextAfter: number, reReadTokens: number, reReadFiles: number, newReadTokens: number, toolOutputTokens: number, growthTokens: number }} RebuildRow one shrink and what was read again after it */
const median = (/** @type {number[]} */ xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
};
const quantile = (/** @type {number[]} */ xs, /** @type {number} */ q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]);
};

/** The shrinks in one session's main-thread events, each with what was re-read straight afterwards. */
/** @param {any[]} events @returns {RebuildRow[]} */
export function rebuildEvents(events) {
  const main = events.filter((e) => !e.isSidechain);
  /** @type {any[]} */
  const out = [];
  const seen = new Set();
  const readSig = (/** @type {any} */ c) => c.name === "Read" && c.sig;
  main.forEach((e, i) => {
    if (i > 0 && e.context < main[i - 1].context * REPLAY.compactionDrop && main.length - i >= REBUILD.minAfter) {
      for (const p of main.slice(0, i)) for (const c of p.calls || []) if (readSig(c)) seen.add(c.sig);
      let reRead = 0;
      let fresh = 0;
      let files = 0;
      let allOut = 0;
      for (const w of main.slice(i, i + REBUILD.windowResponses)) {
        for (const c of w.calls || []) {
          if (c.resChars && !c.res?.startsWith("!")) allOut += c.resChars / REBUILD.charsPerToken;
          if (!readSig(c) || !c.resChars || c.res?.startsWith("!")) continue;
          const tok = c.resChars / REBUILD.charsPerToken;
          if (seen.has(c.sig)) {
            reRead += tok;
            files += 1;
          } else fresh += tok;
        }
      }
      out.push({ at: e.ts, contextBefore: main[i - 1].context, contextAfter: e.context, reReadTokens: Math.round(reRead), reReadFiles: files, newReadTokens: Math.round(fresh), toolOutputTokens: Math.round(allOut), growthTokens: Math.max(0, main[i + REBUILD.windowResponses].context - e.context) });
    }
  });
  return out;
}

/** Across sessions: the distribution, set against the assumption the model uses. */
/** @param {RebuildRow[]} rows */
export function summarizeRebuild(rows) {
  const re = rows.map((r) => r.reReadTokens);
  const enough = rows.length >= REBUILD.minEvents;
  return {
    events: rows.length,
    enough,
    medianReReadTokens: median(re),
    p25ReReadTokens: quantile(re, 0.25),
    p75ReReadTokens: quantile(re, 0.75),
    zeroShare: rows.length ? Math.round((re.filter((x) => !x).length / rows.length) * 100) : 0,
    medianNewReadTokens: median(rows.map((r) => r.newReadTokens)),
    medianToolOutputTokens: median(rows.map((r) => r.toolOutputTokens)),
    p75ToolOutputTokens: quantile(rows.map((r) => r.toolOutputTokens), 0.75),
    medianGrowthTokens: median(rows.map((r) => r.growthTokens)),
    p75GrowthTokens: quantile(rows.map((r) => r.growthTokens), 0.75),
    modelAssumesTokens: REPLAY.rebuildTokens,
    confidence: enough ? "measured on real shrinks (a proxy for a fresh start)" : `too few shrinks (${rows.length} of ${REBUILD.minEvents} needed) to replace the assumption`
  };
}
