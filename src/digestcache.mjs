import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic, stateDir } from "./state.mjs";

/**
 * Weekly digest delivery. Building the digest takes seconds, so a hook never builds it: it starts a detached background build
 * (like the plan cache), and shows a one-line summary once per digest on a later prompt. Nothing here runs on a schedule of its own.
 */
const WEEK = 7 * 86400e3;
export const digestPath = () => path.join(stateDir(), "digest.json");
const shownPath = () => path.join(stateDir(), "digest-shown.json");
const lockPath = () => path.join(stateDir(), "digest.lock");

export const readDigest = () => readJson(digestPath());
/** Save a built digest. `shown: true` when the user is reading it right now, so the hook does not repeat it as a one-liner. */
export function writeDigest(/** @type {any} */ digest, now = Date.now(), { shown = false } = {}) {
  writeJsonAtomic(digestPath(), { computedAt: now, digest });
  if (shown) writeJsonAtomic(shownPath(), { computedAt: now });
}
export const clearDigestLock = () => {
  try {
    fs.unlinkSync(lockPath());
  } catch {}
};

/** Start a detached background build when there is no digest or the last one is a week old. Returns true if one was started. */
export function scheduleDigest({ now = Date.now(), spawnFn = null } = {}) {
  if (process.env.SPARELIMIT_NO_REFRESH && !spawnFn) return false; // tests and CI never start background processes
  const cur = readDigest();
  if (cur && now - cur.computedAt < WEEK) return false;
  const lock = readJson(lockPath());
  if (lock && now - lock.t < 5 * 60e3) return false;
  try {
    writeJsonAtomic(lockPath(), { t: now, pid: process.pid });
    const sparelimit = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sparelimit.mjs");
    (spawnFn || ((/** @type {any} */ cmd, /** @type {any} */ a, /** @type {any} */ o) => spawn(cmd, a, o).unref()))(process.execPath, [sparelimit, "__refresh-digest"], { detached: true, stdio: "ignore", env: process.env });
    return true;
  } catch {
    return false;
  }
}

const usd = (/** @type {number} */ n) => `$${Math.round(n).toLocaleString("en-US")}`;

/** The one line for the user, once per digest, or null (nothing built yet, already shown, older than two weeks, or no spend). */
export function digestLineOnce({ now = Date.now() } = {}) {
  const cur = readDigest();
  if (!cur || now - cur.computedAt > 2 * WEEK) return null;
  if (readJson(shownPath())?.computedAt === cur.computedAt) return null;
  const d = cur.digest;
  if (!d?.spend?.thisWeekUSD) return null;
  writeJsonAtomic(shownPath(), { computedAt: cur.computedAt });
  const change = d.spend.changePct != null ? ` (${d.spend.changePct >= 0 ? "+" : ""}${d.spend.changePct}% on the week before)` : "";
  const limit = d.spend.weeklyLimitPct != null ? `, about ${d.spend.weeklyLimitPct}% of a weekly limit` : "";
  const focus = d.focus ? ` Worth changing first: ${d.focus.title.charAt(0).toLowerCase()}${d.focus.title.slice(1)} (about ${usd(d.focus.usd)}, estimated).` : "";
  return `Weekly digest: ${usd(d.spend.thisWeekUSD)} in the last 7 days${limit}${change}.${focus} Run \`sparelimit digest\` for the details.`;
}
