/**
 * Finding and replaying transcripts: which logs exist on this machine and the views built over all of them (replay, the what-to-change card,
 * the digest, a session timeline). Split out of sparelimit.mjs (A11).
 */
import { claudeConfigDirs } from "./accounts.mjs";
import { loadConfig } from "./config.mjs";
import { cachedReplay, pruneReplayCache } from "./replaycache.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditPath } from "./state.mjs";
import { buildAdoption, readMarkers } from "./adoption.mjs";
import { buildDigest } from "./digest.mjs";
import { buildHabitCard } from "./habits.mjs";
import { buildLedger } from "./ledger.mjs";
import { buildSessionTimeline } from "./sessiontimeline.mjs";
import { buildWhy } from "./why.mjs";
import { codexSessionFiles, desktopProjectRoots, isClaudeLog, projectLabel } from "./sources.mjs";
import { fitLimits, loadCalibration } from "./planestimate.mjs";
import { parseTranscript } from "./adapters/index.mjs";
import { replaySession, summarize } from "./replay.mjs";

// Claude Code names a project folder after its cwd with "/" and "." replaced by "-".
export function claudeProjectDirName(/** @type {any} */ cwd) {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Auto-discover active local agent transcripts across Antigravity, Claude Code, Cursor, and local folders
 */
export const fsDirs = (/** @type {any} */ p) => {
  try {
    return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
};

/**
 * @returns {{ filePath: string, mtimeMs: number, size: number, explicit?: boolean, projectMatch?: boolean }[]}
 */
export function discoverTranscripts(/** @type {any} */ explicitPath, { global = false, cwd = process.cwd() } = {}) {
  // An explicit path always wins: return only that file.
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    try {
      const stat = fs.statSync(resolved);
      return [{ filePath: resolved, mtimeMs: stat.mtimeMs, size: stat.size, explicit: true }];
    } catch {
      return [];
    }
  }

  const found = new Set();

  // 1. Antigravity brain sessions
  const agyBrainDir = path.join(os.homedir(), ".gemini", "antigravity", "brain");
  try {
    if (fs.existsSync(agyBrainDir)) {
      const dirs = fs.readdirSync(agyBrainDir);
      for (const id of dirs) {
        const p = path.join(agyBrainDir, id, ".system_generated", "logs", "transcript.jsonl");
        try {
          if (fs.existsSync(p)) found.add(p);
        } catch {}
      }
    }
  } catch {}

  // 2. Claude Code project sessions
  const claudeDir = path.join(os.homedir(), ".claude", "projects");
  // every Claude config folder (the default one, CLAUDE_CONFIG_DIR, ~/.claude-*, and the ones listed in the config file), for the analysis views
  const configDirs = global ? claudeConfigDirs({ extra: loadConfig().accounts.dirs }) : [path.join(os.homedir(), ".claude")];
  for (const cfg of configDirs) {
    const root = path.join(cfg, "projects");
    try {
      for (const proj of fs.readdirSync(root)) {
        const projPath = path.join(root, proj);
        try {
          for (const f of fs.readdirSync(projPath)) {
            if (f.endsWith(".jsonl")) found.add(path.join(projPath, f));
          }
        } catch {}
      }
    } catch {}
  }

  // 2b. Claude Code sessions kept by the Claude Desktop app (agent mode, Cowork). Only for the analysis views (global): the live HUD
  // and hooks follow the project you are in, and a Desktop session is not one.
  if (global) {
    for (const root of desktopProjectRoots()) {
      for (const proj of fsDirs(root)) {
        try {
          for (const f of fs.readdirSync(path.join(root, proj))) if (f.endsWith(".jsonl")) found.add(path.join(root, proj, f));
        } catch {}
      }
    }
  }

  // 2c. Codex CLI sessions, for the analysis views only
  if (global) for (const f of codexSessionFiles()) found.add(f);

  // 3. Local workspace transcript if present
  const localTranscript = path.join(cwd, "transcript.jsonl");
  if (fs.existsSync(localTranscript)) {
    found.add(localTranscript);
  }

  const all = Array.from(found)
    .map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return { filePath, mtimeMs: stat.mtimeMs, size: stat.size };
      } catch {
        return null;
      }
    })
    .filter(/** @param {any} x @returns {x is { filePath: string, mtimeMs: number, size: number }} */ (x) => x !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (global) return all;

  // Default: transcripts that belong to the current project come first, so `sparelimit` in
  // project X never reports on project Y. Other transcripts stay available as a fallback.
  const projectDir = path.join(claudeDir, claudeProjectDirName(cwd)) + path.sep;
  const mine = all.filter((t) => t.filePath.startsWith(projectDir) || path.dirname(t.filePath) === cwd);
  if (mine.length > 0) return [...mine.map((t) => ({ ...t, projectMatch: true })), ...all.filter((t) => !mine.includes(t))];
  return all;
}

/** Replay every Claude Code transcript on this machine: { results, summary }, or null when there are none. */
export function replayAll() {
  const targets = discoverTranscripts(null, { global: true }).filter((t) => isClaudeLog(t.filePath));
  if (!targets.length) return null;
  const results = [];
  const touched = new Set();
  for (const t of targets) {
    // each session's result is cached by its log's signature, so only logs that changed are parsed again (A10)
    const r = cachedReplay(t.filePath, () => {
      const session = parseTranscript(t.filePath);
      return session && replaySession(session, { withEvents: true });
    }, { touched });
    if (r) results.push(r);
  }
  pruneReplayCache(touched);
  return { results, summary: summarize(results) };
}

/** The "what to change" card over all Claude Code transcripts on this machine, or null when there are none. */
export function computeHabitCard() {
  const all = replayAll();
  return all && buildHabitCard(all.summary, { weeklyLimitUSD: fitLimits(loadCalibration().points).weeklyUSD });
}

/** Claude Code transcripts on this machine, newest first: { id, project, mtimeMs, sizeMB, filePath }. */
export function listClaudeSessions() {
  return discoverTranscripts(null, { global: true })
    .filter((t) => isClaudeLog(t.filePath))
    .map((t) => ({ id: path.basename(t.filePath, ".jsonl"), project: projectLabel(path.basename(path.dirname(t.filePath))), mtimeMs: t.mtimeMs, sizeMB: Math.round((t.size / 1048576) * 10) / 10, filePath: t.filePath }));
}

/** One session's replay (with per-response events) by id (or a unique start of one), or "latest"; null when none matches. */
export function replayFor(/** @type {any} */ idOrLatest) {
  const list = listClaudeSessions();
  const hit = !idOrLatest || idOrLatest === "latest" ? list[0] : list.find((x) => x.id === idOrLatest) || (idOrLatest.length >= 8 && list.filter((x) => x.id.startsWith(idOrLatest)).length === 1 ? list.find((x) => x.id.startsWith(idOrLatest)) : null);
  if (!hit) return null;
  const session = parseTranscript(hit.filePath);
  const result = session && replaySession(session, { withEvents: true });
  return result && result.timeline?.length ? result : null;
}

/** One session's timeline by id (or a unique start of one), or "latest"; null when none matches. */
export function timelineFor(/** @type {any} */ idOrLatest) {
  const result = replayFor(idOrLatest);
  return result ? { ...buildSessionTimeline({ result, auditRows: readAuditRows() }), why: buildWhy(result) } : null;
}

/** The weekly digest over all Claude Code transcripts on this machine, or null when there are none. */
export function readAuditRows() {
  try {
    return fs.readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export function computeDigest() {
  const all = replayAll();
  if (!all) return null;
  const auditRows = readAuditRows();
  const weeklyLimitUSD = fitLimits(loadCalibration().points).weeklyUSD;
  const ledger = buildLedger({ auditRows, results: all.results, weeklyLimitUSD, sinceMs: Date.now() - 7 * 86400e3 });
  const adoption = buildAdoption({ results: all.results, markers: readMarkers(), auditRows });
  return buildDigest({ events: all.results.flatMap((r) => r.timeline), results: all.results, auditRows, weeklyLimitUSD, adoption, ledger });
}
