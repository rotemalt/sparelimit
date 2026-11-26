import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { readJson, writeJsonAtomic, appendJsonl, snapshotPath, quotaLogPath } from "./state.mjs";
import { burnFromHistory } from "./rates.mjs";

export const hash = (/** @type {any} */ s) => crypto.createHash("sha256").update(`sparelimit:${s}`).digest("hex").slice(0, 12);
const num = (/** @type {any} */ x) => (typeof x === "number" && Number.isFinite(x) ? x : null);

/**
 * Who is signed in to Claude Code right now. Read from the CLI's own account metadata at the moment the
 * status line runs, so attribution is exact per session (no polling, no "unattributed" gaps). Only a hash
 * of the account/org id plus the org name and plan type are kept; the email is never read into the snapshot.
 */
/** An organisation name for display. A personal account is often named after its email ("name@example.com's Organization"): that is shown as "personal". */
export const safeLabel = (/** @type {string} */ name) => (typeof name === "string" && name.trim() && !/@/.test(name) ? name.trim().slice(0, 80) : "personal");

export function readAccount({ env = process.env, home = os.homedir() } = {}) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  const candidates = [path.join(dir, ".claude.json"), path.join(home, ".claude.json")];
  for (const f of candidates) {
    const j = readJson(f);
    const a = j?.oauthAccount;
    if (!a) continue;
    const idSource = a.organizationUuid || a.accountUuid;
    if (!idSource) continue;
    return {
      id: hash(idSource),
      accountHash: a.accountUuid ? hash(a.accountUuid) : null, // the account alone (the id above is the organisation's when there is one), to tell accounts apart
      label: safeLabel(a.organizationName),
      orgType: a.organizationType || null,
      billing: a.billingType || null,
      seatTier: a.seatTier || null,
      configDir: dir
    };
  }
  return { id: null, label: "api-key or unknown", configDir: dir };
}

/** Build the snapshot from the JSON Claude Code sends to the status-line command. */
/**
 * @param {any} input
 * @param {{ now?: number, account?: any }} [opts]
 */
export function snapshotFromStatusline(input, { now = Date.now(), account = null } = {}) {
  const cw = input.context_window || {};
  const cu = cw.current_usage || {};
  const rl = input.rate_limits || {};
  const win = (/** @type {any} */ w) => (w && num(w.used_percentage) != null ? { pct: w.used_percentage, resetsAt: num(w.resets_at) } : null);
  const repo = input.workspace?.repo;
  return {
    _schema: "sparelimit-snapshot-v1",
    confidence: "exact",
    sessionId: input.session_id,
    sessionName: input.session_name || null,
    updatedAt: new Date(now).toISOString(),
    receivedAtMs: now,
    model: input.model?.id || null,
    cwd: input.workspace?.current_dir || input.cwd || null,
    project: { dir: input.workspace?.project_dir || null, repo: repo ? { host: repo.host, owner: repo.owner, name: repo.name } : null },
    account,
    contextTokens: num(cw.total_input_tokens),
    contextWindow: num(cw.context_window_size),
    contextPct: num(cw.used_percentage),
    cacheReadTokens: num(cu.cache_read_input_tokens),
    costUsd: num(input.cost?.total_cost_usd),
    durationMs: num(input.cost?.total_duration_ms),
    linesAdded: num(input.cost?.total_lines_added),
    linesRemoved: num(input.cost?.total_lines_removed),
    rateLimits: { fiveHour: win(rl.five_hour), sevenDay: win(rl.seven_day) }
  };
}

const fmt = (/** @type {any} */ s) => {
  const parts = [];
  if (s.contextPct != null) parts.push(`ctx ${Math.round(s.contextPct)}%`);
  if (s.costUsd != null) parts.push(`$${s.costUsd.toFixed(2)}`);
  if (s.rateLimits.fiveHour) parts.push(`5h ${Math.round(s.rateLimits.fiveHour.pct)}%`);
  if (s.rateLimits.sevenDay) parts.push(`7d ${Math.round(s.rateLimits.sevenDay.pct)}%`);
  if (s.burn?.fiveHourPctPerHour > 0) parts.push(`${s.burn.fiveHourPctPerHour}%/h`);
  else if (s.burn?.costPerHourUSD > 0) parts.push(`$${s.burn.costPerHourUSD}/h`);
  return parts.join(" · ") || "sparelimit";
};

/**
 * Status-line entry point: persist the snapshot (and quota history for research), then print one line.
 * If `chain` is set, the user's existing status-line command is run with the same input and its output is shown instead.
 */
/**
 * @param {any} rawInput
 * @param {{ chain?: string | null, now?: number, account?: any }} [opts]
 */
export function handleStatusline(rawInput, { chain = null, now = Date.now(), account } = {}) {
  let input;
  try {
    input = JSON.parse(rawInput);
  } catch {
    return "sparelimit";
  }
  if (!input.session_id) return "sparelimit";
  /** @type {any} */
  const snap = snapshotFromStatusline(input, { now, account: account === undefined ? readAccount() : account });
  try {
    const prev = readJson(snapshotPath(snap.sessionId));
    // Rolling history (last 3 h, one sample per minute or per quota change) so hooks can read recent burn rates cheaply.
    const hist = (prev?.history || []).filter((/** @type {any} */ x) => now - x.t < 3 * 3600e3);
    const sample = { t: now, cost: snap.costUsd, fh: snap.rateLimits.fiveHour?.pct ?? null, sd: snap.rateLimits.sevenDay?.pct ?? null, ctx: snap.contextTokens };
    const last = hist[hist.length - 1];
    if (!last || now - last.t >= 60e3 || last.fh !== sample.fh || last.sd !== sample.sd) hist.push(sample);
    snap.history = hist.slice(-200);
    snap.burn = burnFromHistory(snap.history, now);
    writeJsonAtomic(snapshotPath(snap.sessionId), snap);
    const f = snap.rateLimits.fiveHour?.pct;
    const w = snap.rateLimits.sevenDay?.pct;
    if ((f != null || w != null) && (prev?.rateLimits?.fiveHour?.pct !== f || prev?.rateLimits?.sevenDay?.pct !== w)) {
      appendJsonl(quotaLogPath(), { t: snap.updatedAt, sessionId: snap.sessionId, account: snap.account?.id, fiveHourPct: f ?? null, sevenDayPct: w ?? null, fiveHourResetsAt: snap.rateLimits.fiveHour?.resetsAt ?? null, contextTokens: snap.contextTokens, cacheReadTokens: snap.cacheReadTokens, costUsd: snap.costUsd, model: snap.model });
    }
  } catch {}
  if (chain) {
    const r = spawnSync("/bin/sh", ["-c", chain], { input: rawInput, encoding: "utf8", timeout: 1500 });
    if (r.status === 0 && r.stdout) return r.stdout.replace(/\n+$/, "");
  }
  return fmt(snap);
}
