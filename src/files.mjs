import path from "node:path";

/**
 * File hygiene (K6): which files cost the most to read, across sessions. A read puts the file's text into the conversation, where it is
 * written once and then re-read on every later response until the conversation shrinks; the replay prices that per read (the same way as
 * every tool output) and keeps each session's 15 most expensive files. So these figures are a floor: a file that was never among a
 * session's top 15 is not here. Dollars are estimated (sizes are characters at about 3.7 per token).
 *
 * A file is flagged when it is read whole (no offset or limit) at FILES.bigTokens or more, at least FILES.minWhole times: the case where
 * reading by range, or splitting the file, would shrink what is carried. That is a suggestion, not a measured saving.
 */
export const FILES = { bigTokens: 8000, minWhole: 2, top: 10 };

/**
 * @param {{ files?: { file: string, reads: number, wholeReads: number, tokens: number, largestReadTokens: number, carryUSD: number }[] }[]} results
 */
export function buildFileHygiene(results) {
  /** @type {Map<string, { file: string, sessions: number, reads: number, wholeReads: number, tokens: number, largestReadTokens: number, carryUSD: number }>} */
  const byFile = new Map();
  for (const r of results) {
    for (const f of r.files || []) {
      const cur = byFile.get(f.file) || { file: f.file, sessions: 0, reads: 0, wholeReads: 0, tokens: 0, largestReadTokens: 0, carryUSD: 0 };
      cur.sessions += 1;
      cur.reads += f.reads;
      cur.wholeReads += f.wholeReads;
      cur.tokens += f.tokens;
      cur.largestReadTokens = Math.max(cur.largestReadTokens, f.largestReadTokens);
      cur.carryUSD += f.carryUSD;
      byFile.set(f.file, cur);
    }
  }
  const files = [...byFile.values()].map((f) => ({
    ...f,
    name: path.join(path.basename(path.dirname(f.file)), path.basename(f.file)),
    carryUSD: Math.round(f.carryUSD * 100) / 100,
    flag: f.largestReadTokens >= FILES.bigTokens && f.wholeReads >= FILES.minWhole ? "read whole, often" : null
  }));
  files.sort((a, b) => b.carryUSD - a.carryUSD);
  return {
    files: files.slice(0, FILES.top),
    flagged: files.filter((f) => f.flag).length,
    totalFiles: files.length,
    confidence: "estimated",
    note: `Each session's ${15} most expensive files are kept, so this is a floor. The dollars are what carrying each read in the conversation cost until it shrank (estimated: sizes are characters at about 3.7 per token). "Read whole, often" means a read of ${FILES.bigTokens / 1000}k+ tokens with no range, ${FILES.minWhole}+ times: reading by range or splitting the file would carry less. That is a suggestion, not a measured saving.`
  };
}
