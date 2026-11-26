import path from "node:path";
import { scrubSecrets } from "./secrets.mjs";
import { HIDDEN_GOAL } from "./redact.mjs";

/**
 * The handoff prompt (C6, `sparelimit reset` v2), built from what the log really holds. It keeps the first line and the goal line the older
 * version had, and adds only things the log can show:
 *   - what you asked before the last request (your words, up to HANDOFF.earlier turns);
 *   - the files in play, with how often each was read and edited and the line ranges the last reads covered;
 *   - commands whose latest run failed and never succeeded afterwards, with the first line of the error.
 * Not included, on purpose: "decisions". The agent's reasoning is not kept in what Sparelimit reads, and a decision guessed from edits would be
 * invented. Every text from a session passes the secret scrubber first. The hidden variant (shown on screens and exports unless
 * SPARELIMIT_SHOW_PROMPTS=1) drops everything that quotes your words.
 */
export const HANDOFF = { earlier: 2, earlierChars: 140, goalChars: 180, files: 5, rangesPerFile: 3, commands: 3, commandChars: 100 };

/** @param {string} t */
const oneLine = (t, n = 180) => scrubSecrets(t).replace(/\s+/g, " ").trim().slice(0, n);

/**
 * @param {{ userTurns: { text: string }[], commandResults: { command: string, ok: boolean, summary: string }[], fileTouches: { file: string, kind: string, id?: string, range?: string }[] }} session
 * @returns {{ prompt: string, hidden: string, scope: string }}
 */
export function buildHandoff(session) {
  /** @type {Map<string, { reads: number, writes: number, ranges: string[] }>} */
  const files = new Map();
  const seen = new Set();
  for (const t of session.fileTouches) {
    if (t.id) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
    }
    if (t.file.includes("/.gemini/") || t.file.includes("/var/folders/")) continue;
    const f = files.get(t.file) || { reads: 0, writes: 0, ranges: [] };
    if (t.kind === "read") f.reads += 1;
    if (t.kind === "write") f.writes += 1;
    if (t.range) f.ranges.push(t.range);
    files.set(t.file, f);
  }
  const ranked = [...files.entries()].sort((a, b) => b[1].reads + b[1].writes - (a[1].reads + a[1].writes));
  const scope = [...new Set(ranked.map(([f]) => path.basename(f)))].slice(0, 4).join(", ") || "target file";
  const turns = session.userTurns;
  const goal = turns.length ? oneLine(turns[turns.length - 1].text) : "Continue implementation";
  const earlier = turns.slice(Math.max(0, turns.length - 1 - HANDOFF.earlier), -1).map((t) => oneLine(t.text, HANDOFF.earlierChars)).filter(Boolean);

  // the latest run of each command decides: one that failed and later passed is not "still failing"
  /** @type {Map<string, { ok: boolean, summary: string }>} */
  const latest = new Map();
  for (const r of session.commandResults) latest.set(r.command, { ok: r.ok, summary: r.summary });
  const failing = [...latest.entries()].filter(([, r]) => !r.ok).slice(-HANDOFF.commands);

  const fileLines = ranked.slice(0, HANDOFF.files).map(([f, c]) => {
    const parts = [c.reads ? `read ${c.reads}×` : "", c.writes ? `edited ${c.writes}×` : ""].filter(Boolean).join(", ");
    const ranges = [...new Set(c.ranges)].slice(-HANDOFF.rangesPerFile);
    return `  - ${path.basename(f)} (${parts || "touched"})${ranges.length ? `, lines read last: ${ranges.join("; ")}` : ""}`;
  });
  const failLines = failing.map(([cmd, r]) => `  - \`${oneLine(cmd, HANDOFF.commandChars)}\`${r.summary ? `: ${oneLine(r.summary, HANDOFF.commandChars)}` : ""}`);

  const lines = (/** @type {string} */ goalText, withEarlier = true) => [
    `Continue task in ${scope}:`,
    `- Goal from previous session: ${goalText}`,
    ...(withEarlier && earlier.length ? [`- Before that you asked: ${earlier.map((e) => `"${e}"`).join(" / ")}`] : []),
    `- Focus ONLY on: ${scope}`,
    ...(fileLines.length > 1 ? ["- Files in play (reads and edits in the old session):", ...fileLines] : []),
    ...(failLines.length ? ["- Still failing when the session ended:", ...failLines] : []),
    "- Constraints: Read target lines first, output minimal diff only (no full-file rewrites), verify with tests before finishing."
  ].join("\n");
  return { prompt: lines(`"${goal}"`), hidden: lines(HIDDEN_GOAL, false), scope };
}
