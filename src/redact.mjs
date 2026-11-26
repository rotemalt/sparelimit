import os from "node:os";
import path from "node:path";

/**
 * D2: what leaves the process as data (the live API, the files written for the web HUD and the project status file) carries no prompt text
 * by default. The full report stays in memory for the actions you take yourself (`sparelimit reset`, the reset button, the copy button), which
 * is where the text is wanted. `SPARELIMIT_SHOW_PROMPTS=1` turns the redaction off.
 *
 *   userTurns[].text        removed (the length stays)
 *   failedCommands          the command name only; the error summary is removed
 *   handoffPrompt           the quoted goal (your last request) is replaced by a placeholder
 *   transcriptPath          the file name only
 *   touchedFiles, reReadFiles  your home folder is shown as ~
 */
export const HIDDEN_GOAL = "[your last request is hidden; Sparelimit shows it only when you reset or set SPARELIMIT_SHOW_PROMPTS=1]";

export const showPrompts = (env = process.env) => env.SPARELIMIT_SHOW_PROMPTS === "1";

export function redactReport(/** @type {any} */ report, { show = showPrompts(), home = os.homedir() } = {}) {
  if (!report || typeof report !== "object" || !Object.keys(report).length) return report;
  const { handoffPromptHidden, ...rest } = report;
  if (show) return rest;
  const tilde = (/** @type {any} */ p) => (typeof p === "string" && home && p.startsWith(home + path.sep) ? "~" + p.slice(home.length) : p);
  return {
    ...rest,
    redacted: true,
    transcriptPath: rest.transcriptPath ? path.basename(rest.transcriptPath) : rest.transcriptPath,
    userTurns: (rest.userTurns || []).map((/** @type {any} */ { stepIndex, createdAt, text }) => ({ stepIndex, createdAt, chars: String(text || "").length })),
    failedCommands: (rest.failedCommands || []).map((/** @type {any} */ f) => ({ command: String(f.command || "").trim().split(/\s+/)[0] || "" })),
    touchedFiles: (rest.touchedFiles || []).map((/** @type {any} */ f) => ({ ...f, file: tilde(f.file) })),
    reReadFiles: (rest.reReadFiles || []).map((/** @type {any} */ f) => ({ ...f, file: tilde(f.file) })),
    handoffPrompt: handoffPromptHidden ?? rest.handoffPrompt
  };
}
