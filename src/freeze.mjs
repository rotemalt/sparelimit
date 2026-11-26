import fs from "node:fs";
import path from "node:path";

/**
 * Scope freeze (C9): `sparelimit freeze` lists the files the work is about, and the PreToolUse hook then refuses edits to any other file. Safety:
 * it applies only in the project folder that holds `.sparelimit-freeze.json`; it expires after `ttlHours` so a forgotten lock cannot strand
 * anyone; `sparelimit allow` (an override) lets edits through; `sparelimit freeze --off` removes it. Only tools that write a file are checked, and a
 * path that cannot be read from the call is allowed (a guard must never block on a guess).
 */
export const FREEZE = { ttlHours: 8, file: ".sparelimit-freeze.json", tools: ["Edit", "Write", "MultiEdit", "NotebookEdit"] };

const WRITE = new Set(FREEZE.tools);

/** The frozen scope in a folder, or null when there is none, it is unreadable, empty or expired. */
export function readFreeze(/** @type {any} */ cwd, now = Date.now()) {
  if (!cwd || typeof cwd !== "string") return null;
  let j;
  try {
    j = JSON.parse(fs.readFileSync(path.join(cwd, FREEZE.file), "utf8"));
  } catch {
    return null;
  }
  const names = Array.isArray(j?.lockedFiles) ? j.lockedFiles.filter((/** @type {any} */ x) => typeof x === "string" && x) : [];
  const paths = Array.isArray(j?.lockedPaths) ? j.lockedPaths.filter((/** @type {any} */ x) => typeof x === "string" && x) : [];
  if (!names.length && !paths.length) return null;
  const made = Date.parse(j.createdAt);
  const ttl = (typeof j.ttlHours === "number" && j.ttlHours > 0 ? j.ttlHours : FREEZE.ttlHours) * 3600e3;
  if (!Number.isFinite(made) || now - made > ttl) return null;
  return { names, paths, expiresAt: made + ttl };
}

/** null when the call is allowed; otherwise { message } for the block. */
/** @param {{ cwd: string, toolName: string, toolInput: any, now?: number }} p */
export function checkFreeze({ cwd, toolName, toolInput, now = Date.now() }) {
  if (!WRITE.has(toolName)) return null;
  const fz = readFreeze(cwd, now);
  if (!fz) return null;
  const target = toolInput?.file_path || toolInput?.notebook_path;
  if (typeof target !== "string" || !target) return null;
  const abs = path.resolve(cwd, target);
  const rel = path.relative(cwd, abs).split(path.sep).join("/");
  if (rel.startsWith("..")) return null; // outside this project: not this freeze's business
  const ok = fz.paths.length ? fz.paths.includes(rel) : fz.names.includes(path.basename(abs));
  if (ok) return null;
  const list = (fz.paths.length ? fz.paths : fz.names).slice(0, 12).join(", ");
  const mins = Math.max(1, Math.round((fz.expiresAt - now) / 60e3));
  return { message: `sparelimit: scope is frozen to ${list}. ${rel} is not in it. Ask the user before touching other files: they can run \`sparelimit freeze --off\` to lift the freeze or \`sparelimit allow\` to let edits through for a while (it also lifts itself in ${mins} min).` };
}
