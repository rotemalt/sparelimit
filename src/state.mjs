import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const stateDir = () => process.env.SPARELIMIT_HOME || path.join(os.homedir(), ".sparelimit");
const safe = (/** @type {string} */ id) => String(id || "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);

/**
 * The parsed JSON in a file, or `fallback` when it is missing or broken.
 * @param {string} file
 * @param {any} [fallback]
 * @returns {any}
 */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Atomic write: readers (hooks fire concurrently with the status line) never see a half-written file. */
export function writeJsonAtomic(/** @type {string} */ file, /** @type {any} */ data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export const snapshotPath = (/** @type {string} */ sessionId) => path.join(stateDir(), "live", `${safe(sessionId)}.json`);
export const sessionStatePath = (/** @type {string} */ sessionId) => path.join(stateDir(), "state", `${safe(sessionId)}.json`);
export const auditPath = () => path.join(stateDir(), "audit.jsonl");
export const quotaLogPath = () => path.join(stateDir(), "quota-log.jsonl");
export const overridePath = () => path.join(stateDir(), "override.json");
export const probePath = () => path.join(stateDir(), "probe.json");
export const configPath = () => path.join(stateDir(), "config.json");

export function appendJsonl(/** @type {string} */ file, /** @type {any} */ obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
}
