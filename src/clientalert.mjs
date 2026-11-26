import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson, writeJsonAtomic, stateDir } from "./state.mjs";
import { clientOf, encodeProject } from "./clients.mjs";
import { periodStarts } from "./budget.mjs";

/**
 * Client budget alerts inside a running session. Totalling spend per client means reading every log, so a hook never does it: it starts a
 * detached background refresh (like the digest) and reads the saved result. The figures can be up to REFRESH_MS old, which the line says.
 */
const REFRESH_MS = 15 * 60e3;
const USABLE_MS = 2 * 3600e3;
const WARN_PCT = 80;
export const clientBudgetPath = () => path.join(stateDir(), "client-budgets.json");
const lockPath = () => path.join(stateDir(), "client-budgets.lock");

export const readClientBudgets = () => readJson(clientBudgetPath());
/** @param {any} check the clients' budgets @param {number} [now] @param {any} [overall] the machine-wide daily/weekly/monthly budgets (checkBudgets) */
export const writeClientBudgets = (check, now = Date.now(), overall = null) => writeJsonAtomic(clientBudgetPath(), { computedAt: now, check, overall });
export const clearClientBudgetLock = () => {
  try {
    fs.unlinkSync(lockPath());
  } catch {}
};

/** Start a detached background refresh when the saved totals are older than 15 minutes. Returns true if one was started. */
export function scheduleClientBudgets({ now = Date.now(), spawnFn = null } = {}) {
  if (process.env.SPARELIMIT_NO_REFRESH && !spawnFn) return false; // tests and CI never start background processes
  const cur = readClientBudgets();
  if (cur && now - cur.computedAt < REFRESH_MS) return false;
  const lock = readJson(lockPath());
  if (lock && now - lock.t < 5 * 60e3) return false;
  try {
    writeJsonAtomic(lockPath(), { t: now, pid: process.pid });
    const sparelimit = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sparelimit.mjs");
    (spawnFn || ((/** @type {string} */ cmd, /** @type {string[]} */ a, /** @type {any} */ o) => spawn(cmd, a, o).unref()))(process.execPath, [sparelimit, "__refresh-client-budgets"], { detached: true, stdio: "ignore", env: process.env });
    return true;
  } catch {
    return false;
  }
}

/**
 * The line for a session working in `cwd`, or null. Only the client that folder belongs to is looked at. A period is said once per level
 * (nearing 80%, then over) in `shown`, which the caller keeps per session; a new period (a new day, week, month) is a new key.
 * @param {{ cwd: string, rules: { path?: string, contains?: string, label: string }[], shown: Record<string, string>, now?: number }} p
 * @returns {string | null}
 */
export function clientBudgetLine({ cwd, rules, shown, now = Date.now() }) {
  const cur = readClientBudgets();
  if (!cur || now - cur.computedAt > USABLE_MS || !rules.length) return null;
  const label = clientOf(encodeProject(path.resolve(cwd)), rules);
  const client = label && cur.check?.clients?.find((/** @type {any} */ c) => c.label === label);
  if (!client) return null;
  return budgetSentence(`Client budget, ${label}`, client.rows, shown, cur.computedAt, now, label);
}

/**
 * The sentence for the rows of one budget that are near (80%) or over their limit and not yet said at that level this period, or null.
 * @param {string} title @param {{ key: string, period?: string, label?: string, spentUSD: number, limitUSD: number | null, pct: number | null, over: boolean }[]} rows
 * @param {Record<string, string>} shown @param {number} computedAt @param {number} now @param {string} scope
 */
function budgetSentence(title, rows, shown, computedAt, now, scope) {
  const lines = [];
  for (const r of rows) {
    if (r.limitUSD == null || r.pct == null) continue;
    const level = r.over ? "over" : r.pct >= WARN_PCT ? "near" : null;
    const key = `${scope}|${r.key}|${/** @type {Record<string, number>} */ (periodStarts(now))[r.key]}`;
    if (!level || shown[key] === level || (shown[key] === "over" && level === "near")) continue;
    shown[key] = level;
    lines.push(`${r.period || r.label} $${r.spentUSD} of $${r.limitUSD} (${r.pct}%)`);
  }
  if (!lines.length) return null;
  const mins = Math.max(1, Math.round((now - computedAt) / 60e3));
  return `${title}: ${lines.join("; ")}. API-equivalent dollars, as of ${mins} min ago.`;
}

/**
 * The line for the machine-wide budgets (`sparelimit budget daily=50 ...`), same rules as the client ones. Null when none is set or near.
 * @param {{ shown: Record<string, string>, now?: number }} p
 */
export function overallBudgetLine({ shown, now = Date.now() }) {
  const cur = readClientBudgets();
  if (!cur?.overall || now - cur.computedAt > USABLE_MS) return null;
  return budgetSentence("Budget", cur.overall.rows, shown, cur.computedAt, now, "*");
}
