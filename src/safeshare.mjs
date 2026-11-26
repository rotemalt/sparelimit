/**
 * `sparelimit safe-to-share <file>`: look for what should not be in a picture, a post or a page before it goes public. It reads one text file
 * (a printed output, JSON, SVG, HTML, Markdown) and lists what it finds by kind, with the line and a masked sample. It never prints a whole
 * secret, never changes the file and sends nothing. It cannot read the pixels of a PNG or JPG: for those, check the output it was made from.
 *
 * What it looks for: home-folder paths, email addresses, session ids (whole and the short form `1a2b3c4d…`), exact times (to the minute or
 * second: they show when you work), credential shapes (the same list `sparelimit` hides before a handoff), and the names on this machine: your
 * user name, your computer's name and the names of your project folders.
 * A clean result means none of these was found. It does not mean the file is safe in every way: read it yourself once.
 */
import { scrubSecrets } from "./secrets.mjs";

/** @typedef {{ kind: string, line: number, sample: string }} Finding */

/** @type {[string, RegExp][]} */
const KINDS = [
  ["home path", /(?:\/Users\/|\/home\/|C:\\Users\\)[A-Za-z0-9._-]+(?:[\/\\][^\s"'<>]*)?|~\/[^\s"'<>]+/g],
  ["email address", /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g],
  ["session id", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g],
  ["short session id", /\b[0-9a-f]{8}…/g],
  ["exact time", /\b20\d{2}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z?\b/g]
];

const mask = (/** @type {string} */ s) => (s.length <= 8 ? s.slice(0, 2) + "…" : s.slice(0, 4) + "…" + s.slice(-2));
const GENERIC = new Set(["src", "app", "test", "tests", "docs", "home", "site", "web", "api", "lib", "build", "dist", "main", "code", "work", "temp", "tmp", "user", "users", "desktop", "documents", "downloads"]);
const esc = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * @param {string} text
 * @param {{ names?: string[] }} [opts] names that belong to this machine (user, computer, project folders)
 * @returns {Finding[]}
 */
export function scan(text, { names = [] } = {}) {
  /** @type {Finding[]} */
  const out = [];
  const lines = text.split("\n");
  const own = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 4 && !GENERIC.has(n.toLowerCase())))];
  const ownRe = own.length ? new RegExp(`(?<![A-Za-z0-9])(?:${own.map(esc).join("|")})(?![A-Za-z0-9])`, "gi") : null;
  lines.forEach((line, i) => {
    for (const [kind, re] of KINDS) for (const m of line.matchAll(re)) out.push({ kind, line: i + 1, sample: mask(String(m[0])) });
    if (ownRe) for (const m of line.matchAll(ownRe)) out.push({ kind: "a name from this machine", line: i + 1, sample: mask(m[0]) });
    if (scrubSecrets(line) !== line) out.push({ kind: "credential shape", line: i + 1, sample: "(hidden)" });
  });
  return out;
}

/** Counts by kind, in the order first seen. @param {Finding[]} f */
export function summarize(f) {
  /** @type {Map<string, { n: number, lines: number[], sample: string }>} */
  const by = new Map();
  for (const x of f) {
    const c = by.get(x.kind) || { n: 0, lines: [], sample: x.sample };
    c.n += 1;
    if (c.lines.length < 5 && !c.lines.includes(x.line)) c.lines.push(x.line);
    by.set(x.kind, c);
  }
  return [...by].map(([kind, v]) => ({ kind, ...v }));
}

export const IMAGE = /\.(png|jpe?g|gif|webp|heic|pdf)$/i;
