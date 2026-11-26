import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readAccount, hash } from "./collector.mjs";

/**
 * Accounts on this machine (I2, I3). People with more than one Claude account usually keep a config folder for each, selected with
 * CLAUDE_CONFIG_DIR (`~/.claude`, `~/.claude-work`, ...), and every folder has its own `projects/` logs and its own signed-in account. So a
 * session belongs to the account of the config folder its log is in, and that needs no guessing. The account is read the way the status line
 * collector reads it: a hash of the account or organisation id, the organisation name and the plan type. The email is never read.
 *
 * Folders considered: `~/.claude`, CLAUDE_CONFIG_DIR, any `~/.claude-*`, `~/.claude_*` or `~/.claude.*` folder that has a `projects` folder, and
 * the folders you list in `accounts.dirs` of the config file. Labels you give (`accounts.labels`, by folder or by account id) win over the
 * organisation name. Sessions the Desktop app runs in agent mode keep no account in their logs, so they are listed apart.
 *
 * Not checked: this machine has one config folder and one account. The discovery and the attribution are tested on built folders, not on a
 * second real account. Plan usage and its estimate are still for the default account only.
 */
const isDir = (/** @type {string} */ p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** @param {{ home?: string, env?: Record<string, string | undefined>, extra?: string[] }} [p] */
export function claudeConfigDirs({ home = os.homedir(), env = process.env, extra = [] } = {}) {
  const out = new Set();
  const add = (/** @type {any} */ d) => {
    if (typeof d === "string" && d && path.isAbsolute(d) && isDir(path.join(d, "projects"))) out.add(path.resolve(d));
  };
  add(path.join(home, ".claude"));
  add(env.CLAUDE_CONFIG_DIR);
  try {
    for (const e of fs.readdirSync(home, { withFileTypes: true })) if (e.isDirectory() && /^\.claude[-_.][\w.-]+$/.test(e.name)) add(path.join(home, e.name));
  } catch {}
  for (const d of extra) add(d);
  return [...out];
}

/** The account of a config folder, with the label you gave it if any. */
/** @param {string} dir @param {{ home?: string, labels?: Record<string, string> }} [p] */
export function accountOf(dir, { home = os.homedir(), labels = {} } = {}) {
  // The default folder's account file is ~/.claude.json, beside the folder; any other folder keeps its own `.claude.json` inside it, and must
  // never fall back to the default account's file.
  const isDefault = path.resolve(dir) === path.join(home, ".claude");
  const a = isDefault ? readAccount({ env: {}, home }) : readAccount({ env: { CLAUDE_CONFIG_DIR: dir }, home: path.join(home, "__none__") });
  const known = a.id ? a : { ...a, id: null };
  const label = labels[dir] || (known.id && labels[known.id]) || known.label;
  return { id: known.id, accountHash: /** @type {any} */ (a).accountHash ?? null, label, plan: [known.orgType, known.billing, known.seatTier].filter(Boolean).join(" · ") || null, configDir: dir, named: !!(labels[dir] || (known.id && labels[known.id])) };
}

/** Which config folder holds a log (the longest match), or null. */
/** @param {string} filePath @param {string[]} dirs @returns {string | null} */
export function dirOfLog(filePath, dirs) {
  const p = String(filePath);
  let best = null;
  for (const d of dirs) if ((p === d || p.startsWith(d + path.sep)) && (!best || d.length > best.length)) best = d;
  return best;
}

const DAY = 86400e3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Does a Desktop owner (from the path) belong to the account of this config folder? The account UUID decides when the folder's account has
 * one: an account with several organisations has sessions under several org folders, and another account may have an org folder with the
 * same name. Only when the folder's account UUID is unknown (an account file without one) is the organisation id used.
 * @param {{ accountUuid: string, ids: string[] }} owner @param {{ id: string | null, accountHash?: string | null }} acct
 */
function ownerMatches(owner, acct) {
  if (acct.accountHash) return hash(owner.accountUuid) === acct.accountHash;
  return !!acct.id && owner.ids.includes(acct.id);
}

/**
 * Whose a Desktop agent-mode log is, from its path: `local-agent-mode-sessions/<account uuid>/<organisation uuid>/local_<id>/...`. On the one
 * machine checked, the first folder is the signed-in account's accountUuid and the second its organizationUuid, the two ids a config folder's
 * account is hashed from. Null when the path is not that shape (any other layout is left unattributed).
 * @returns {{ accountUuid: string, orgUuid: string, ids: string[] } | null}
 */
export function desktopOwner(/** @type {string} */ file) {
  const m = String(file).match(/[\\/]local-agent-mode-sessions[\\/]([^\\/]+)[\\/]([^\\/]+)[\\/]/);
  if (!m || !UUID.test(m[1]) || !UUID.test(m[2])) return null;
  return { accountUuid: m[1], orgUuid: m[2], ids: [hash(m[2]), hash(m[1])] };
}

/**
 * Spend and sessions per account from the replay results (each has `project`, the folder its log is in, and a per-response timeline).
 * Sessions in no known config folder are grouped as "Claude Desktop agent" when they are in the Desktop app's folder, else "other".
 */
/** @param {any[]} results @param {string[]} dirs */
export function summarizeAccounts(results, dirs, { home = os.homedir(), labels = {}, now = Date.now() } = {}) {
  const rows = new Map();
  /** @type {Map<string, string | null>} */
  const homeOfOwner = new Map();
  const row = (/** @type {string} */ key, /** @type {any} */ base) => rows.get(key) || rows.set(key, { ...base, sessions: 0, totalUSD: 0, last7DaysUSD: 0, lastActive: null }).get(key);
  for (const r of results) {
    const dir = dirOfLog(r.project, dirs);
    let key;
    let base;
    if (dir) {
      key = dir;
      base = accountOf(dir, { home, labels });
    } else if (/local-agent-mode-sessions/.test(String(r.project))) {
      const owner = desktopOwner(r.project);
      const ownerKey = owner ? owner.accountUuid + owner.orgUuid : "";
      if (owner && !homeOfOwner.has(ownerKey)) homeOfOwner.set(ownerKey, dirs.find((/** @type {string} */ d) => ownerMatches(owner, accountOf(d, { home, labels }))) ?? null); // one lookup per owner, not per session
      const home_ = owner && homeOfOwner.get(ownerKey);
      if (home_) {
        // the app signed in as an account whose config folder is known: its agent-mode sessions are that account's
        key = home_;
        base = accountOf(home_, { home, labels });
      } else if (owner) {
        key = `desktop-agent:${owner.accountUuid}`;
        base = { id: null, label: `Claude Desktop agent (account ${owner.accountUuid.slice(0, 8)})`, plan: null, configDir: null, named: false, note: "agent-mode sessions of a Desktop account with no config folder here" };
      } else {
        key = "desktop-agent";
        base = { id: null, label: "Claude Desktop agent (agent mode)", plan: null, configDir: null, named: false, note: "the path of these agent-mode sessions names no account" };
      }
    } else {
      key = "other";
      base = { id: null, label: "Other", plan: null, configDir: null, named: false };
    }
    const x = row(key, base);
    x.sessions += 1;
    x.totalUSD += r.totalCostUSD || 0;
    for (const e of r.timeline || []) if (e.t >= now - 7 * DAY) x.last7DaysUSD += e.cost;
    const end = Date.parse(r.end);
    if (Number.isFinite(end) && (!x.lastActive || end > Date.parse(x.lastActive))) x.lastActive = new Date(end).toISOString();
  }
  const out = [...rows.values()].map((x) => ({ ...x, totalUSD: Math.round(x.totalUSD * 100) / 100, last7DaysUSD: Math.round(x.last7DaysUSD * 100) / 100 }));
  out.sort((a, b) => b.totalUSD - a.totalUSD);
  return { accounts: out, configDirs: dirs.length, note: "Dollars are API-equivalent at list price (derived). A session belongs to the account of the config folder its log is in. Plan usage is estimated for the default account only." };
}

/**
 * Plan usage is per account (I4): each account has its own 5-hour and weekly limits, so each needs its own calibration and its own spend.
 * "The current account" is the one this shell uses: CLAUDE_CONFIG_DIR if it is set (a hook runs with the environment of the Claude Code
 * session, so it lands on the right account without being told), else the default folder.
 */
export const defaultConfigDir = ({ home = os.homedir() } = {}) => path.join(home, ".claude");
export const currentConfigDir = ({ home = os.homedir(), env = process.env } = {}) => path.resolve(env.CLAUDE_CONFIG_DIR || defaultConfigDir({ home }));

const DESKTOP_LOG = /[\\/]local-agent-mode-sessions[\\/]/;

/**
 * Does a log count toward the plan usage of the account whose config folder is `dir`? A log in another KNOWN config folder does not. The
 * Desktop app's agent-mode sessions record no account, so they count only for the default account (an assumption: the app signs in as the
 * account the default folder holds). A log outside every known folder is counted (it cannot be told apart, and one account is the common case).
 */
/** @param {string} dir @param {string[]} knownDirs */
export function planScope(dir, knownDirs, { home = os.homedir() } = {}) {
  const here = path.resolve(dir);
  const isDefault = here === defaultConfigDir({ home });
  /** @type {Map<string, boolean>} the answer per Desktop account: this runs once per log file and reading the account is a file read */
  const desktopMemo = new Map();
  return (/** @type {string} */ file) => {
    const d = dirOfLog(file, knownDirs);
    if (d) return path.resolve(d) === here;
    if (DESKTOP_LOG.test(String(file))) {
      const owner = desktopOwner(file);
      if (!owner) return isDefault;
      const memo = desktopMemo.get(owner.accountUuid + owner.orgUuid);
      if (memo != null) return memo;
      const holder = knownDirs.find((/** @type {string} */ d) => ownerMatches(owner, accountOf(d, { home })));
      // the account the path names has a config folder: its sessions are that account's. A named account with none is nobody's here,
      // unless the default folder has no readable account to compare (then the old assumption stands).
      const yes = holder ? path.resolve(holder) === here : isDefault && !accountOf(defaultConfigDir({ home }), { home }).id;
      desktopMemo.set(owner.accountUuid + owner.orgUuid, yes);
      return yes;
    }
    return true;
  };
}

/** A config folder from what you typed: its path, its label (not case-sensitive) or the start of its account id. Null when none or ambiguous. */
/** @param {string} spec @param {string[]} dirs */
export function resolveAccount(spec, dirs, { home = os.homedir(), labels = {} } = {}) {
  const s = String(spec || "").trim();
  if (!s) return null;
  const hits = dirs.filter((/** @type {string} */ d) => {
    if (path.resolve(d) === path.resolve(s)) return true;
    const a = accountOf(d, { home, labels });
    return a.label.toLowerCase() === s.toLowerCase() || (a.id && s.length >= 4 && a.id.startsWith(s));
  });
  return hits.length === 1 ? hits[0] : null;
}
