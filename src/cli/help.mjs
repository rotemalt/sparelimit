/** `sparelimit help`: the five commands to start with, and `sparelimit help all` for every command by what it is for. */
import { VERSION } from "../constants.mjs";

const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const b = (/** @type {string} */ s) => (tty ? `\x1b[1m${s}\x1b[0m` : s);
const dim = (/** @type {string} */ s) => (tty ? `\x1b[2m${s}\x1b[0m` : s);

/** The first five: what a new user runs, in order. */
export const START = [
  ["sparelimit replay --all", "Where your limit went, across every past Claude Code session"],
  ["sparelimit card", "The same as a picture and a page you can share (no prompts or paths)"],
  ["sparelimit coach", "The three habits that cost you the most, ranked"],
  ["sparelimit init --apply", "Warn me while I work, before I am cut off"],
  ["sparelimit plan", "How much of the 5-hour and weekly limit is used, and a forecast"]
];

/** Every command, grouped by the question it answers. @type {[string, string[]][]} */
export const GROUPS = [
  ["See where it went", ["sparelimit (the live view)", "replay", "why", "timeline", "history", "files", "drains", "card", "serve (local dashboard)"]],
  ["Know what to change", ["coach", "digest", "setup", "models", "delegate"]],
  ["Stay inside the limit", ["plan", "calibrate", "budget", "policy", "playbooks", "act", "reset", "allow", "freeze", "muzzle", "watch"]],
  ["Check the proof", ["ledger", "efficacy", "adopt", "track", "rebuild", "value", "quota-fit", "method"]],
  ["Other agents", ["codex", "gemini", "cursor"]],
  ["Accounts, devices and clients", ["accounts", "sync", "clients", "report --client"]],
  ["Share what you found", ["week", "safe-to-share <file>"]],
  ["The optional count (off unless you say yes)", ["count status", "count show", "count on", "count off"]],
  ["Set up", ["init", "doctor", "rule", "mcp", "status --json"]]
];

/** @param {boolean} all */
export function helpText(all) {
  const w = Math.max(...START.map(([c]) => c.length));
  const lines = [`${b("sparelimit")} ${VERSION}: don't waste your AI coding limit. Runs on your machine; nothing is sent unless you switch it on.`, "", b("Start here")];
  for (const [c, what] of START) lines.push(`  ${b(c.padEnd(w))}  ${what}`);
  if (all) {
    for (const [title, cmds] of GROUPS) lines.push("", b(title), `  ${cmds.join(" · ")}`);
    lines.push("", dim("Each command is described in the README; `sparelimit method` says how every number is computed."));
  } else lines.push("", dim("`sparelimit help all` lists every command. `sparelimit method` says how every number is computed."));
  return lines.join("\n");
}

/** @type {Record<string, (args: string[]) => Promise<void>>} */
export const commands = {
  help: async (args) => console.log(helpText(args.includes("all") || args.includes("--all"))),
  "--help": async (args) => console.log(helpText(args.includes("all") || args.includes("--all"))),
  "-h": async () => console.log(helpText(false)),
  "--version": async () => console.log(VERSION),
  "-v": async () => console.log(VERSION)
};
