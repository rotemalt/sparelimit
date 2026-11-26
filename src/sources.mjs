import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeConfigDirs } from "./accounts.mjs";

/**
 * Where Claude Code logs live (X17). Besides `~/.claude/projects`, the Claude Desktop app runs Claude Code for its agent mode (Cowork) and
 * keeps those logs in its own data folder, one `.claude/projects` per session:
 *
 *   <Claude data folder>/local-agent-mode-sessions/<account>/<workspace>/local_<id>/.claude/projects/<project>/<session>.jsonl
 *
 * They are the same log format, and they draw on the same plan, so leaving them out undercounts spend and plan usage. The layout is the
 * app's own and not documented: the walk is bounded (three levels, `local_*` folders only) and anything unexpected is skipped.
 * Checked on macOS only; the Windows and Linux data folders below are where the app is expected to keep them.
 */
export function desktopDataDir({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Claude");
  if (platform === "win32") return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "Claude");
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "Claude");
}

const dirs = (/** @type {any} */ p) => {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

/** Every `.claude/projects` folder under the Desktop app's agent-mode sessions. */
export function desktopProjectRoots(opts = /** @type {any} */ ({})) {
  const base = path.join(opts.dataDir || desktopDataDir(opts), "local-agent-mode-sessions");
  const roots = [];
  for (const a of dirs(base)) for (const b of dirs(path.join(base, a))) for (const s of dirs(path.join(base, a, b))) {
    if (!s.startsWith("local_")) continue;
    const root = path.join(base, a, b, s, ".claude", "projects");
    if (dirs(path.dirname(root)).includes("projects")) roots.push(root);
  }
  return roots;
}

/** All roots to read, the Claude Code one first. */
export function claudeProjectRoots(opts = /** @type {any} */ ({})) {
  const home = opts.home || os.homedir();
  const dirs = claudeConfigDirs({ home, env: opts.env || process.env, extra: opts.extra || [] }).map((d) => path.join(d, "projects"));
  const first = path.join(home, ".claude", "projects");
  return [...new Set([first, ...dirs]), ...desktopProjectRoots(opts)];
}

/** True for a log kept in the Desktop app's folder. */
export const isDesktopLog = (/** @type {string} */ filePath) => String(filePath).includes(`${path.sep}local-agent-mode-sessions${path.sep}`);

/**
 * A readable project name from a log's folder name. Claude Code names the folder after the working directory with separators turned
 * into dashes; Desktop agent mode uses a sandbox name ("-sessions-calm-quick-turing") or, when the work happened in the session's outputs
 * folder, the whole path of that folder. Neither says anything useful, so those become "Claude Desktop agent" with the sandbox name.
 */
export function projectLabel(/** @type {any} */ dirName) {
  const n = String(dirName || "");
  const sandbox = n.match(/^-sessions-(.+)$/);
  if (sandbox) return `Claude Desktop agent: ${sandbox[1]}`;
  if (/local-agent-mode-sessions/.test(n)) return "Claude Desktop agent (session outputs)";
  // The folder name starts with the user's home folder: "-Users-name-" (macOS), "C--Users-name-" (Windows), "-home-name-" (Linux). Drop it.
  return n.replace(/^(?:[A-Za-z]-)?-(?:Users|home)-[^-]+-/, "");
}

/**
 * Codex CLI sessions (A7): `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`. Three levels of date folders, plain JSONL only (the compressed
 * archive is not read). Bounded and read-only.
 */
export function codexSessionFiles({ home = os.homedir(), env = process.env } = {}) {
  const base = path.join(env.CODEX_HOME || path.join(home, ".codex"), "sessions");
  const out = [];
  for (const y of dirs(base)) for (const m of dirs(path.join(base, y))) for (const d of dirs(path.join(base, y, m))) {
    try {
      for (const f of fs.readdirSync(path.join(base, y, m, d))) if (/^rollout-.*\.jsonl$/.test(f)) out.push(path.join(base, y, m, d, f));
    } catch {}
  }
  return out;
}

/**
 * Gemini CLI sessions (A8): `~/.gemini/tmp/<project>/chats/session-*.json` (older) and `session-*.jsonl`. GEMINI_CLI_HOME, when set,
 * holds the `.gemini` folder. Bounded to two levels and read-only.
 */
export function geminiSessionFiles({ home = os.homedir(), env = process.env } = {}) {
  const base = path.join(env.GEMINI_CLI_HOME ? path.join(env.GEMINI_CLI_HOME, ".gemini") : path.join(home, ".gemini"), "tmp");
  /** @type {string[]} */
  const out = [];
  for (const p of dirs(base)) {
    try {
      for (const f of fs.readdirSync(path.join(base, p, "chats"))) if (/^session-.*\.jsonl?$/.test(f)) out.push(path.join(base, p, "chats", f));
    } catch {}
  }
  return out;
}

export const isCodexLog = (/** @type {string} */ filePath) => /[\\/]sessions[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/]rollout-[^\\/]*\.jsonl$/.test(String(filePath));

/** Claude Code's logs (including Desktop agent mode). The coaching views read only these: their rules (cache lifetime, model families) are Claude's. */
export const isClaudeLog = (/** @type {string} */ filePath) => /[\\/]\.claude[-_.\w]*[\\/]projects[\\/]/.test(String(filePath)) || String(filePath).includes(`${path.sep}.claude${path.sep}`);
