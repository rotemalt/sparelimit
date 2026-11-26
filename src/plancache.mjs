import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { estimatePlanUsage, loadCalibration, accountScope } from "./planestimate.mjs";
import { loadConfig } from "./config.mjs";
import { readJson, writeJsonAtomic, stateDir } from "./state.mjs";
import { claudeProjectRoots } from "./sources.mjs";

/**
 * Incremental cache of (time, cost) for every Claude Code response in the last N days, so hooks can estimate plan usage in a few
 * milliseconds instead of re-parsing every transcript. A background refresher re-parses only files whose size/mtime changed.
 */
const DAY = 86400e3;
export const cachePath = () => path.join(stateDir(), "plan-cache.json");
const lockPath = () => path.join(stateDir(), "plan-cache.lock");
export const readPlanCache = () => readJson(cachePath(), null);

/** Signature of a session: its main file plus any subagent files (their changes do not touch the main file). */
function signature(/** @type {string} */ file) {
  const st = fs.statSync(file);
  let sig = `${Math.round(st.mtimeMs)}:${st.size}`;
  const sub = path.join(path.dirname(file), path.basename(file, ".jsonl"), "subagents");
  try {
    for (const f of fs.readdirSync(sub)) {
      const s = fs.statSync(path.join(sub, f));
      sig += `|${f}:${Math.round(s.mtimeMs)}:${s.size}`;
    }
  } catch {}
  return { sig, mtimeMs: st.mtimeMs };
}

export async function refreshPlanCache({ now = Date.now(), days = 8, root = null } = {}) {
  const prev = readPlanCache() || { version: 1, files: {} };
  const [{ parseTranscript }, { priceEvent }, { loadPricing }] = await Promise.all([import("./adapters/index.mjs"), import("./analyze.mjs"), import("./pricing.mjs")]);
  const pricing = loadPricing();
  const since = now - days * DAY;
  /** @type {Record<string, any>} */
  const files = {};
  let parsed = 0;
  let reused = 0;
  const list = [];
  // every place Claude Code logs live (the Desktop app's agent-mode sessions too); an explicit root reads only that one
  for (const r of root ? [root] : claudeProjectRoots({ extra: loadConfig().accounts.dirs })) {
    try {
      for (const proj of fs.readdirSync(r)) {
        const dir = path.join(r, proj);
        /** @type {string[]} */
        let names = [];
        try {
          names = fs.readdirSync(dir);
        } catch {}
        for (const f of names) if (f.endsWith(".jsonl")) list.push(path.join(dir, f));
      }
    } catch {}
  }
  for (const file of list) {
    try {
      const { sig, mtimeMs } = signature(file);
      if (mtimeMs < since - DAY) continue; // untouched for over a day beyond the window: cannot hold recent events
      const cached = prev.files[file];
      if (cached && cached.sig === sig) {
        files[file] = cached;
        reused += 1;
        continue;
      }
      const s = parseTranscript(file);
      const events = [];
      if (s) for (const e of s.events) if (e.ts) {
        const t = new Date(e.ts).getTime();
        if (t >= since) events.push([t, Number(priceEvent(e, pricing).cost.toFixed(6))]);
      }
      files[file] = { sig, events };
      parsed += 1;
    } catch {}
  }
  const cache = { version: 1, computedAt: now, days, files };
  writeJsonAtomic(cachePath(), cache);
  return { cache, parsed, reused };
}

/** All cached events, oldest first, as { t, cost }. */
/**
 * @param {any} cache
 * @param {number} [sinceMs]
 * @param {((file: string) => boolean) | null} [scope]
 */
export function cacheEvents(cache, sinceMs = 0, scope = null) {
  const out = [];
  for (const [file, f] of Object.entries(cache?.files || {})) {
    if (scope && !scope(file)) continue;
    for (const [t, cost] of f.events) if (t >= sinceMs) out.push({ t, cost });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Plan-usage estimate from the cache (a few ms), or null when there is no cache or no calibration yet. */
export function planEstimateFromCache({ now = Date.now(), cache = readPlanCache(), calibration = loadCalibration(), scope = accountScope() } = {}) {
  if (!cache || !calibration.points.length) return null;
  const est = estimatePlanUsage({ now, events: cacheEvents(cache, now - cache.days * DAY, scope), calibration });
  if (!est.fiveHour && !est.weekly) return null;
  return { ...est, cacheAgeMs: now - cache.computedAt };
}

/** Start a detached background refresh if the cache is older than maxAgeMs and none is running. Returns true if one was started. */
export function scheduleRefresh({ now = Date.now(), maxAgeMs = 45_000, spawnFn = null } = {}) {
  if (process.env.SPARELIMIT_NO_REFRESH && !spawnFn) return false; // tests and CI never start background processes
  const cache = readPlanCache();
  if (cache && now - cache.computedAt < maxAgeMs) return false;
  const lock = readJson(lockPath());
  if (lock && now - lock.t < 120_000) return false;
  try {
    writeJsonAtomic(lockPath(), { t: now, pid: process.pid });
    const sparelimit = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sparelimit.mjs");
    (spawnFn || ((/** @type {any} */ cmd, /** @type {any} */ a, /** @type {any} */ o) => spawn(cmd, a, o).unref()))(process.execPath, [sparelimit, "__refresh-plan"], { detached: true, stdio: "ignore", env: process.env });
    return true;
  } catch {
    return false;
  }
}

export const clearLock = () => {
  try {
    fs.unlinkSync(lockPath());
  } catch {}
};
