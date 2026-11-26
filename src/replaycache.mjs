import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic, stateDir } from "./state.mjs";

/**
 * Cache of each session's replay result (A10), so the views over all sessions (coach, digest, ledger, budgets, timeline picker) read what
 * changed instead of re-parsing every log on every run. An entry is used only when BOTH match: the log's signature (modified time and size
 * of the file and of its subagent files) and a fingerprint of the code and prices that produced it. Change the replay logic, the adapters,
 * the price list or your own price overrides, and every entry is recomputed. A damaged entry is recomputed. `SPARELIMIT_NO_CACHE=1` turns it off.
 */
const SRC = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(SRC, "..");
export const CACHE_VERSION = 1;
const CODE = ["replay.mjs", "analyze.mjs", "pricing.mjs", "policy.mjs", "delegation.mjs", "models.mjs", "schema.mjs", "rates.mjs", "adapters/index.mjs", "adapters/claude-code.mjs"].map((f) => path.join(SRC, f));
const DATA = ["pricing.snapshot.json", "pricing.overrides.json"].map((f) => path.join(ROOT, "data", f));

const stat = (/** @type {any} */ f) => {
  try {
    const s = fs.statSync(f);
    return `${f}:${Math.round(s.mtimeMs)}:${s.size}`;
  } catch {
    return `${f}:none`;
  }
};

/** What produced a result: the code and the prices. */
export const fingerprint = () => crypto.createHash("sha1").update([CACHE_VERSION, ...CODE.map(stat), ...DATA.map(stat), stat(path.join(process.env.SPARELIMIT_HOME || stateDir(), "pricing.json"))].join("|")).digest("hex").slice(0, 16);

/** Signature of a session: its main file plus any subagent files (their changes do not touch the main file). */
export function logSignature(/** @type {string} */ file) {
  const st = fs.statSync(file);
  let sig = `${Math.round(st.mtimeMs)}:${st.size}`;
  const sub = path.join(path.dirname(file), path.basename(file, ".jsonl"), "subagents");
  try {
    for (const f of fs.readdirSync(sub)) {
      const s = fs.statSync(path.join(sub, f));
      sig += `|${f}:${Math.round(s.mtimeMs)}:${s.size}`;
    }
  } catch {}
  return sig;
}

const dir = () => path.join(stateDir(), "replay-cache");
const entryName = (/** @type {string} */ file) => crypto.createHash("sha1").update(file).digest("hex").slice(0, 24) + ".json";

/**
 * The cached result for a log, or compute() and store it. `touched` collects the entry names used, for pruning.
 * compute() returns the result or null (nothing is stored for null).
 */
/**
 * @param {string} file
 * @param {() => any} compute
 * @param {{ touched?: Set<string> | null, fp?: string }} [opts]
 */
export function cachedReplay(file, compute, { touched = null, fp = fingerprint() } = {}) {
  if (process.env.SPARELIMIT_NO_CACHE) return compute();
  let sig;
  try {
    sig = logSignature(file);
  } catch {
    return compute();
  }
  const name = entryName(file);
  touched?.add(name);
  const hit = readJson(path.join(dir(), name), null);
  if (hit && hit.fp === fp && hit.sig === sig && hit.file === file && hit.result) return hit.result;
  const result = compute();
  if (result) {
    try {
      fs.mkdirSync(dir(), { recursive: true });
      writeJsonAtomic(path.join(dir(), name), { fp, sig, file, result });
    } catch {}
  }
  return result;
}

/** Remove entries that were not used in a full run (logs that no longer exist, or old fingerprints). Call only after a run over every log. */
export function pruneReplayCache(/** @type {any} */ touched) {
  try {
    for (const f of fs.readdirSync(dir())) if (f.endsWith(".json") && !touched.has(f)) fs.unlinkSync(path.join(dir(), f));
  } catch {}
}
