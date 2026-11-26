import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desktopProjectRoots, desktopDataDir, claudeProjectRoots, projectLabel, isDesktopLog } from "../src/sources.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-src-"));
const data = desktopDataDir({ home, env: {} });
const sessions = path.join(data, "local-agent-mode-sessions");
const line = (id, min) => JSON.stringify({ type: "assistant", sessionId: "desk-1", uuid: id, timestamp: new Date(Date.now() - min * 60e3).toISOString(), message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 40000, cache_creation_input_tokens: 0, output_tokens: 100 }, content: [] } });
const mk = (...parts) => fs.mkdirSync(path.join(...parts), { recursive: true });
// two real-looking agent sessions, one folder that is not a session, and one session without a projects folder
mk(sessions, "acct", "ws", "local_aaa", ".claude", "projects", "-sessions-calm-quick-turing");
mk(sessions, "acct", "ws", "local_bbb", ".claude", "projects", "-Users-x-Library-Application-Support-Claude-local-agent-mode-sessions-acct-ws-local-bbb-outputs");
mk(sessions, "acct", "ws", "other_ccc", ".claude", "projects", "-sessions-ignored");
mk(sessions, "acct", "ws", "local_ddd", "no-projects-here");
fs.writeFileSync(path.join(sessions, "acct", "ws", "local_aaa", ".claude", "projects", "-sessions-calm-quick-turing", "desk-1.jsonl"), [line("m1", 10), line("m2", 5)].join("\n") + "\n");
fs.writeFileSync(path.join(sessions, "acct", "ws", "local_aaa", "audit.jsonl"), "{}\n"); // not a transcript

test("Desktop agent-mode roots: only local_* sessions that have a .claude/projects folder; none when the app is not installed", () => {
  const roots = desktopProjectRoots({ dataDir: data }).map((r) => path.relative(sessions, r).split(path.sep).join("/"));
  assert.deepEqual(roots.sort(), ["acct/ws/local_aaa/.claude/projects", "acct/ws/local_bbb/.claude/projects"]);
  assert.deepEqual(desktopProjectRoots({ dataDir: path.join(home, "nowhere") }), []);
  assert.equal(claudeProjectRoots({ home, dataDir: data })[0], path.join(home, ".claude", "projects"), "the Claude Code folder comes first");
  assert.equal(isDesktopLog(path.join(sessions, "a", "x.jsonl")), true);
  assert.equal(isDesktopLog("/Users/a/.claude/projects/p/x.jsonl"), false);
});

test("project names: a working directory loses its prefix; Desktop sandboxes and session-output folders get a plain name, never a long path", () => {
  assert.equal(projectLabel("-Users-dana-Downloads-MyApp"), "Downloads-MyApp");
  assert.equal(projectLabel("-sessions-calm-quick-turing"), "Claude Desktop agent: calm-quick-turing");
  assert.equal(projectLabel("-Users-dana-Library-Application-Support-Claude-local-agent-mode-sessions-a-b-local-c-outputs"), "Claude Desktop agent (session outputs)");
  assert.equal(projectLabel(undefined), "");
});

test("discovery: the analysis views (global) include the Desktop agent sessions; the live view does not", async () => {
  const saved = { HOME: process.env.HOME, X: process.env.XDG_CONFIG_HOME, A: process.env.APPDATA };
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  try {
    const { discoverTranscripts } = await import("../sparelimit.mjs");
    const names = (g) => discoverTranscripts(null, { global: g, cwd: home }).map((t) => path.basename(t.filePath));
    assert.deepEqual(names(true).filter((n) => n === "desk-1.jsonl"), ["desk-1.jsonl"]);
    assert.ok(!names(true).includes("audit.jsonl"), "the app's audit log is not a transcript");
    assert.ok(!names(false).includes("desk-1.jsonl"));
  } finally {
    for (const [k, v] of [["HOME", saved.HOME], ["XDG_CONFIG_HOME", saved.X], ["APPDATA", saved.A]]) v == null ? delete process.env[k] : (process.env[k] = v);
  }
});

test("the plan estimate's cache reads the Desktop sessions too, so they count toward the plan", async () => {
  const saved = { HOME: process.env.HOME, V: process.env.SPARELIMIT_HOME, X: process.env.XDG_CONFIG_HOME, A: process.env.APPDATA };
  process.env.HOME = home;
  process.env.SPARELIMIT_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-state-"));
  delete process.env.XDG_CONFIG_HOME;
  process.env.APPDATA = path.join(home, "AppData", "Roaming");
  try {
    const { refreshPlanCache, cacheEvents } = await import("../src/plancache.mjs");
    const { cache } = await refreshPlanCache({ now: Date.now(), days: 8 });
    const ev = cacheEvents(cache, 0);
    assert.equal(ev.length, 2);
    assert.ok(ev.every((e) => e.cost > 0));
  } finally {
    for (const [k, v] of [["HOME", saved.HOME], ["SPARELIMIT_HOME", saved.V], ["XDG_CONFIG_HOME", saved.X], ["APPDATA", saved.A]]) v == null ? delete process.env[k] : (process.env[k] = v);
  }
});

test("a project label never keeps the person's name, on any operating system's folder style", () => {
  assert.equal(projectLabel("C--Users-dana-work-app"), "work-app");
  assert.equal(projectLabel("-home-dana-work-app"), "work-app");
  assert.equal(projectLabel("-Users-dana-work-app"), "work-app");
});
