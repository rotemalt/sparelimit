import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { priceEvent } from "./analyze.mjs";
import { accountOf, dirOfLog } from "./accounts.mjs";
import { readJson, stateDir, writeJsonAtomic } from "./state.mjs";

/**
 * Sync through a folder you already have (E5, stage A). `sparelimit sync --dir <folder>` writes ONE small JSON file for this device into the
 * folder and reads the files the other devices wrote there, to show one combined view. The folder can be iCloud Drive, Dropbox, Syncthing
 * or a private git repository: moving the file between machines is theirs, the format is ours. Nothing is sent by Sparelimit itself.
 *
 * What a file holds, and all it holds: for each UTC day, account and model, the token classes and the list-price dollars. Plus the device
 * (a random id and a name) and the account labels. Never a prompt, a file path, a project name, a session id or any code: the writer builds
 * each row from numbers and from a model name that resolved against the price list, and the reader keeps only those fields from files it
 * did not write, so a file from another device cannot carry anything else into this view.
 *
 * Days are UTC so two devices in different time zones put a response on the same day. Dollars are API-equivalent at list price (derived).
 */
export const SYNC_FORMAT = 1;
const KIND = "sparelimit-sync";
const FILE_RE = /^sparelimit-sync-([A-Za-z0-9]{8,64})\.json$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 50000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;
const num = (/** @type {any} */ v) => (Number.isFinite(v) && v >= 0 ? v : 0);
const text = (/** @type {any} */ v, /** @type {number} */ max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

/** This device: a random id made once and kept in the state folder, and a name (the machine's host name unless you chose one). */
/** @param {{ name?: string }} [p] */
export function thisDevice({ name } = {}) {
  const file = path.join(stateDir(), "device.json");
  let d = readJson(file, null);
  if (!d || typeof d.id !== "string" || !/^[A-Za-z0-9]{8,64}$/.test(d.id)) d = { id: crypto.randomBytes(8).toString("hex") };
  if (name) d.name = text(name, 40);
  if (!d.name) d.name = text(os.hostname().replace(/\.local$/, ""), 40) || "this device";
  writeJsonAtomic(file, d);
  return { id: d.id, name: d.name };
}

/**
 * The aggregate rows of this device from parsed sessions.
 * @param {{ filePath: string, session: any }[]} sessions parsed Claude Code sessions with the log file each came from
 * @param {{ pricing: any, dirs?: string[], labels?: Record<string, string>, home?: string, device: { id: string, name: string }, now?: number }} p
 */
export function buildDeviceFile(sessions, { pricing, dirs = [], labels = {}, home = os.homedir(), device, now = Date.now() }) {
  /** @type {Map<string, any>} */
  const acctCache = new Map();
  const acctFor = (/** @type {string} */ filePath) => {
    const dir = dirOfLog(filePath, dirs);
    if (!dir) return /desktop|local-agent-mode/.test(filePath) ? { key: "desktop-agent", label: "Claude Desktop agent" } : { key: "other", label: "Other" };
    if (!acctCache.has(dir)) {
      const a = accountOf(dir, { home, labels });
      acctCache.set(dir, { key: a.id || `folder-${crypto.createHash("sha1").update(dir).digest("hex").slice(0, 8)}`, label: a.label });
    }
    return acctCache.get(dir);
  };
  /** @type {Map<string, any>} */
  const rows = new Map();
  /** @type {Record<string, string>} */
  const accounts = {};
  for (const { filePath, session } of sessions) {
    if (!session || !Array.isArray(session.events)) continue;
    const a = acctFor(filePath);
    for (const e of session.events) {
      const t = Date.parse(e.ts);
      if (!Number.isFinite(t)) continue;
      const priced = priceEvent(e, pricing);
      const day = new Date(t).toISOString().slice(0, 10);
      const k = `${day}|${a.key}|${priced.key}`;
      const r = rows.get(k) || rows.set(k, { day, account: a.key, model: priced.key, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0 }).get(k);
      r.input += e.usage.input;
      r.cacheRead += e.usage.cacheRead;
      r.cacheWrite += e.usage.cacheWrite5m + e.usage.cacheWrite1h;
      r.output += e.usage.output;
      r.usd += priced.cost;
      accounts[a.key] = a.label;
    }
  }
  const out = [...rows.values()].map((r) => ({ ...r, usd: Math.round(r.usd * 1e6) / 1e6 })).sort((x, y) => (x.day + x.account + x.model).localeCompare(y.day + y.account + y.model));
  return { kind: KIND, format: SYNC_FORMAT, device, generatedAt: new Date(now).toISOString(), accounts, rows: out };
}

/** Write this device's file into the folder (atomically, so a sync client never uploads half of it). Returns the path. */
/** @param {string} dir @param {any} file */
export function writeDeviceFile(dir, file) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `sparelimit-sync-${file.device.id}.json`);
  writeJsonAtomic(target, file);
  return target;
}

/**
 * Read every device file in the folder. A file that cannot be used is skipped with the reason, never fatal: not JSON, too large, not ours,
 * written by a newer version of the format, or without a device. Only the known fields are kept, each checked.
 * @param {string} dir
 * @returns {{ devices: any[], skipped: { file: string, reason: string }[] }}
 */
export function readDeviceFiles(dir) {
  /** @type {any[]} */
  const devices = [];
  /** @type {{ file: string, reason: string }[]} */
  const skipped = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.startsWith("sparelimit-sync-") && n.endsWith(".json")).sort();
  } catch {
    return { devices, skipped: [{ file: dir, reason: "the folder cannot be read" }] };
  }
  for (const name of names) {
    const full = path.join(dir, name);
    const skip = (/** @type {string} */ reason) => skipped.push({ file: name, reason });
    const m = name.match(FILE_RE);
    if (!m) {
      skip("the file name is not a device file");
      continue;
    }
    let raw;
    try {
      if (fs.statSync(full).size > MAX_FILE_BYTES) {
        skip("larger than 8 MB");
        continue;
      }
      raw = JSON.parse(fs.readFileSync(full, "utf8"));
    } catch {
      skip("not valid JSON (a sync client may still be writing it, or it is damaged)");
      continue;
    }
    if (!raw || raw.kind !== KIND || !Number.isInteger(raw.format)) {
      skip("not a Sparelimit sync file");
      continue;
    }
    if (raw.format > SYNC_FORMAT) {
      skip(`written by a newer version of Sparelimit (format ${raw.format}; this one reads ${SYNC_FORMAT}): update Sparelimit on this device`);
      continue;
    }
    if (!Array.isArray(raw.rows) || raw.rows.length > MAX_ROWS) {
      skip("no usable rows");
      continue;
    }
    const id = m[1];
    if (raw.device?.id !== id) {
      skip("the device id inside does not match the file name");
      continue;
    }
    /** @type {Record<string, string>} */
    const accounts = {};
    if (raw.accounts && typeof raw.accounts === "object") for (const [k, v] of Object.entries(raw.accounts).slice(0, 200)) accounts[text(k, 80)] = text(v, 60);
    const rows = [];
    for (const r of raw.rows) {
      if (!r || !DAY_RE.test(r.day)) continue;
      rows.push({ day: r.day, account: text(r.account, 80) || "other", model: text(r.model, 80) || "unknown", input: num(r.input), cacheRead: num(r.cacheRead), cacheWrite: num(r.cacheWrite), output: num(r.output), usd: num(r.usd) });
    }
    const gen = Date.parse(raw.generatedAt);
    devices.push({ id, name: text(raw.device.name, 40) || id.slice(0, 8), generatedAt: Number.isFinite(gen) ? new Date(gen).toISOString() : null, accounts, rows });
  }
  return { devices, skipped };
}

/**
 * One view over all devices: totals, per day, per account (the same account on two devices is one row, matched by its id), per device and
 * per model, for the last `days` UTC days.
 * @param {any[]} devices from readDeviceFiles
 * @param {{ days?: number, now?: number }} [p]
 */
export function mergeDevices(devices, { days = 30, now = Date.now() } = {}) {
  const since = new Date(now - (days - 1) * 86400e3).toISOString().slice(0, 10);
  /** @type {Map<string, any>} */ const byDay = new Map();
  /** @type {Map<string, any>} */ const byAccount = new Map();
  /** @type {Map<string, any>} */ const byModel = new Map();
  const byDevice = [];
  const tok = (/** @type {any} */ r) => r.input + r.cacheRead + r.cacheWrite + r.output;
  const add = (/** @type {Map<string, any>} */ m, /** @type {string} */ k, /** @type {any} */ base, /** @type {any} */ r) => {
    const x = m.get(k) || m.set(k, { ...base, usd: 0, tokens: 0 }).get(k);
    x.usd += r.usd;
    x.tokens += tok(r);
  };
  let usd = 0;
  let tokens = 0;
  for (const d of devices) {
    let dUsd = 0;
    let dTok = 0;
    let lastDay = null;
    for (const r of d.rows) {
      if (r.day < since) continue;
      add(byDay, r.day, { day: r.day }, r);
      add(byAccount, r.account, { account: r.account, label: d.accounts[r.account] || r.account }, r);
      add(byModel, r.model, { model: r.model }, r);
      dUsd += r.usd;
      dTok += tok(r);
      if (!lastDay || r.day > lastDay) lastDay = r.day;
    }
    usd += dUsd;
    tokens += dTok;
    byDevice.push({ id: d.id, name: d.name, usd: r2(dUsd), tokens: dTok, lastDay, updatedAt: d.generatedAt });
  }
  const fin = (/** @type {Map<string, any>} */ m) => [...m.values()].map((x) => ({ ...x, usd: r2(x.usd) }));
  return {
    days,
    since,
    devices: byDevice.sort((a, b) => b.usd - a.usd),
    totalUSD: r2(usd),
    totalTokens: tokens,
    daily: fin(byDay).sort((a, b) => a.day.localeCompare(b.day)),
    accounts: fin(byAccount).sort((a, b) => b.usd - a.usd),
    models: fin(byModel).sort((a, b) => b.usd - a.usd),
    confidence: "derived",
    note: "Dollars are API-equivalent at list price (derived). Days are UTC. Each device reports only its own logs; a device that has not synced lately shows its last update."
  };
}
