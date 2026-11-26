import path from "node:path";
import { readJson, configPath } from "./state.mjs";
import { DEFAULT_POLICY, PRESETS, mergePolicy } from "./policy.mjs";
import { sanitizeClients } from "./clients.mjs";
import { sanitizePlaybooks } from "./playbooks.mjs";

/**
 * Settings (C4): a global file (`~/.sparelimit/config.json`) and an optional per-project file (`.sparelimit/config.json` in the project folder).
 * A project file may only make a check stricter (see tightenOnly). Every value is checked: a number or null where a threshold goes, a known preset name, a list of
 * strings for ignored rules. Anything else is dropped, so a typo can never switch a guard off by accident (a wrong type is ignored, not read
 * as "null = off").
 *
 *   { "policy": { "preset": "agency-day", "context": { "warnPct": 50 } },
 *     "budgets": { "dailyUSD": 50, "weeklyUSD": 200, "monthlyUSD": 700 },
 *     "ignore": { "rules": ["loop.identical_calls"] } }
 */
const num = (/** @type {any} */ v) => v === null || (typeof v === "number" && Number.isFinite(v));

/** @param {any} user @returns {import('./policy.mjs').UserPolicy} */
export function sanitizePolicy(user) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!user || typeof user !== "object") return out;
  if (typeof user.preset === "string" && /** @type {Record<string, unknown>} */ (PRESETS)[user.preset]) out.preset = user.preset;
  for (const sec of /** @type {(keyof typeof DEFAULT_POLICY)[]} */ (Object.keys(DEFAULT_POLICY))) {
    const src = user[sec];
    if (!src || typeof src !== "object") continue;
    for (const [k, v] of Object.entries(src)) {
      if (!(k in DEFAULT_POLICY[sec])) continue;
      const def = /** @type {Record<string, any>} */ (DEFAULT_POLICY[sec])[k];
      if (typeof def === "boolean" ? typeof v === "boolean" : num(v)) (out[sec] ||= {})[k] = v;
    }
  }
  return out;
}

/**
 * What a project's own file may change: it may only make a check stricter. A project folder can be something you downloaded, so it never
 * switches a warning off, raises a limit, ignores a rule, rewrites what your agent reads or makes Sparelimit read other folders.
 * Lower numbers are stricter; null means off; true is stricter for the yes/no settings.
 * @param {any} globalUser @param {any} projectUser
 */
export function tightenOnly(globalUser, projectUser) {
  const base = mergePolicy(globalUser);
  const preset = (projectUser.preset && /** @type {Record<string, any>} */ (PRESETS)[projectUser.preset]) || {};
  /** @type {any} */
  const out = { ...globalUser };
  for (const sec of /** @type {(keyof typeof DEFAULT_POLICY)[]} */ (Object.keys(DEFAULT_POLICY))) {
    const asked = { ...(preset[sec] || {}), ...(projectUser[sec] || {}) };
    for (const [k, v] of Object.entries(asked)) {
      const cur = /** @type {Record<string, any>} */ (base[sec])[k];
      const next = typeof v === "boolean" ? cur || v : v === null ? cur : cur === null ? v : Math.min(cur, /** @type {number} */ (v));
      if (next !== cur) out[sec] = { ...(out[sec] || {}), [k]: next };
    }
  }
  return out;
}

/** The lower of two budgets, key by key. */
const lowest = (/** @type {Record<string, number>} */ a, /** @type {Record<string, number>} */ b) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, Math.min(a[k] ?? Infinity, b[k] ?? Infinity)]));

/** @param {any} b @returns {Record<string, number>} */
export function sanitizeBudgets(b) {
  /** @type {Record<string, number>} */
  const out = {};
  if (!b || typeof b !== "object") return out;
  for (const k of ["dailyUSD", "weeklyUSD", "monthlyUSD"]) if (typeof b[k] === "number" && Number.isFinite(b[k]) && b[k] > 0) out[k] = b[k];
  return out;
}

/** @param {any} i */
/**
 * Output trimming (X14, off by default): a PostToolUse hook may replace a Bash command's output with its head and tail when it is longer
 * than `maxChars`. The tool has already run; only what the agent reads (and carries in the conversation) changes. `dryRun` logs what would
 * have been cut and changes nothing.
 * @param {any} t @returns {{ enabled: boolean, dryRun: boolean, maxChars: number, keepHead: number, keepTail: number }}
 */
export function sanitizeTrim(t) {
  const out = { enabled: false, dryRun: false, maxChars: 20000, keepHead: 4000, keepTail: 4000 };
  if (!t || typeof t !== "object") return out;
  out.enabled = t.enabled === true;
  out.dryRun = t.dryRun === true;
  const int = (/** @type {any} */ v, /** @type {number} */ lo, /** @type {number} */ hi, /** @type {number} */ d) => (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  out.maxChars = int(t.maxChars, 2000, 500000, out.maxChars);
  out.keepHead = int(t.keepHead, 200, 100000, out.keepHead);
  out.keepTail = int(t.keepTail, 200, 100000, out.keepTail);
  if (out.keepHead + out.keepTail >= out.maxChars) {
    // a cut that keeps as much as the limit would trim nothing: fall back to the defaults rather than guess
    out.keepHead = 4000;
    out.keepTail = 4000;
    out.maxChars = Math.max(out.maxChars, 20000);
  }
  return out;
}

/** @param {any} i */
export function sanitizeIgnore(i) {
  const rules = Array.isArray(i?.rules) ? i.rules.filter((/** @type {any} */ r) => typeof r === "string" && /^[a-z_.]{3,60}$/.test(r)) : [];
  return { rules };
}

/** Account settings: extra config folders (absolute paths) and labels by folder or by account id. */
/** @param {any} a */
export function sanitizeAccounts(a) {
  /** @type {{ dirs: string[], labels: Record<string, string> }} */
  const out = { dirs: [], labels: {} };
  if (!a || typeof a !== "object") return out;
  if (Array.isArray(a.dirs)) out.dirs = a.dirs.filter((/** @type {any} */ d) => typeof d === "string" && d.length < 400 && path.isAbsolute(d));
  if (a.labels && typeof a.labels === "object") for (const [k, v] of Object.entries(a.labels)) if (typeof v === "string" && v.trim() && v.length <= 60 && k.length <= 400) out.labels[k] = v.trim();
  return out;
}

/** The settings in force for a project folder: yours, which the project's own file may only make stricter. */
/** @param {{ cwd?: string | null, globalFile?: string }} [p] a null cwd reads the global file only */
export function loadConfig({ cwd = process.cwd(), globalFile = configPath() } = {}) {
  const g = readJson(globalFile, {}) || {};
  const p = cwd ? readJson(path.join(cwd, ".sparelimit", "config.json"), {}) || {} : {};
  return {
    policy: tightenOnly(sanitizePolicy(g.policy), sanitizePolicy(p.policy)),
    budgets: lowest(sanitizeBudgets(g.budgets), sanitizeBudgets(p.budgets)),
    ignore: sanitizeIgnore(g.ignore),
    clients: { rules: [...sanitizeClients(p.clients).rules, ...sanitizeClients(g.clients).rules], budgets: { ...sanitizeClients(p.clients).budgets, ...sanitizeClients(g.clients).budgets } }, // your own budget for a client wins
    trim: sanitizeTrim(g.trim),
    playbooks: sanitizePlaybooks(g.playbooks),
    accounts: { dirs: sanitizeAccounts(g.accounts).dirs, labels: { ...sanitizeAccounts(p.accounts).labels, ...sanitizeAccounts(g.accounts).labels } } // a project adds names, never folders
  };
}
