// @ts-check
/**
 * What a stranger sees when Sparelimit finds no session logs. One place, so every command says the same plain thing: where it looked, and the
 * next step. It never says "pass a path" to someone who has just passed --all.
 */
import os from "node:os";
import path from "node:path";

/** @param {{ home?: string }} [opts] */
export function noLogsMessage(opts = {}) {
  const home = opts.home || os.homedir();
  const where = path.join(home, ".claude", "projects");
  return [
    "Sparelimit found no Claude Code session logs to read.",
    `It looked in ${where}, which is where Claude Code writes them after you use it once.`,
    "Next: use Claude Code for a few minutes, then run this again. If your logs are somewhere else, set CLAUDE_CONFIG_DIR to that folder.",
    "Codex CLI, Gemini CLI or Cursor instead? Try `sparelimit codex`, `sparelimit gemini` or `sparelimit cursor`.",
  ].join("\n");
}
