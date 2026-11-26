import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTranscript } from "../src/adapters/index.mjs";
import { geminiSessionFiles } from "../src/sources.mjs";
import { summarizeGemini } from "../src/geminireport.mjs";
import { loadPricing } from "../src/pricing.mjs";
import { clientEvents } from "../src/clients.mjs";

const HASH = "a".repeat(64);
const msg = (id, ts, type, extra = {}) => ({ id, timestamp: ts, type, content: "", ...extra });
const gem = (id, ts, tokens, extra = {}) => msg(id, ts, "gemini", { model: "gemini-2.5-pro", thoughts: "[]", tokens: { tool: 0, thoughts: 0, cached: 0, ...tokens }, ...extra });
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-gem-"));
const chats = path.join(home, ".gemini", "tmp", "myproj", "chats");
fs.mkdirSync(chats, { recursive: true });
fs.writeFileSync(path.join(home, ".gemini", "projects.json"), JSON.stringify({ projects: { "/work/Acme": "myproj" } }));

const call = (name, args, result, status = "success") => ({ id: `${name}_1`, name, args, result: [{ functionResponse: { name, response: { output: result } } }], status });
const messages = [
  msg("u1", "2026-11-01T10:00:00.000Z", "user", { content: "fix the parser" }),
  gem("g1", "2026-11-01T10:00:05.000Z", { input: 10000, cached: 6000, output: 200, thoughts: 300, tool: 50, total: 10550 }, { toolCalls: [call("read_file", { file_path: "/work/Acme/a.js" }, "text"), call("run_shell_command", { command: "npm test" }, "Error: 2 failed", "error")] }),
  msg("u2", "2026-11-01T10:00:06.000Z", "user", { content: "[Function Response: read_file]..." }),
  gem("g2", "2026-11-01T10:01:00.000Z", { input: 12000, cached: 12000, output: 100, total: 12100 })
];

test("a .json session: tokens map to uncached input, cache read and output (thinking counts as output), tools and files are read", () => {
  const f = path.join(chats, "session-2026-11-01T10-00-abc.json");
  fs.writeFileSync(f, JSON.stringify({ sessionId: "s", projectHash: HASH, startTime: "x", lastUpdated: "y", messages }, null, 2));
  const s = parseTranscript(f);
  assert.equal(s.agent, "gemini");
  assert.equal(s.sessionId, "session-2026-11-01T10-00-abc");
  assert.equal(s.events.length, 2);
  assert.deepEqual(s.events[0].usage, { input: 4000 + 50, cacheRead: 6000, cacheWrite5m: 0, cacheWrite1h: 0, output: 500 });
  assert.equal(s.events[0].context, 10050, "the context is the whole prompt");
  assert.equal(s.projectDir, "/work/Acme", "found from ~/.gemini/projects.json by the folder name");
  assert.deepEqual(s.userTurns.map((u) => u.text), ["fix the parser"], "a function response is not something you typed");
  assert.deepEqual(s.commandResults, [{ command: "npm test", ok: false, summary: "Error: 2 failed" }]);
  assert.deepEqual(s.fileTouches.map((t) => [t.file, t.kind]), [["/work/Acme/a.js", "read"]]);
  assert.ok(s.events[0].calls[1].res.startsWith("!"), "a failed call is marked");
});

test("a .jsonl session: $set patches rewrite messages, the last version of each id counts once", () => {
  const f = path.join(chats, "session-2026-11-01T11-00-def.jsonl");
  const early = gem("g1", "2026-11-01T11:00:05.000Z", { input: 1000, output: 10, total: 1010 });
  const final = gem("g1", "2026-11-01T11:00:05.000Z", { input: 2000, output: 20, total: 2020 });
  const lines = [
    { sessionId: "a2a-server", projectHash: HASH, startTime: "x", lastUpdated: "y", kind: "main" },
    msg("u1", "2026-11-01T11:00:00.000Z", "user", { content: [{ text: "<session_context>\n**Workspace Directories:**\n  - /work/Other\n" }] }),
    early,
    { $set: { lastUpdated: "z" } },
    { $set: { messages: [msg("u1", "2026-11-01T11:00:00.000Z", "user", { content: "hello" }), final] } }
  ];
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const s = parseTranscript(f);
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].usage.input, 2000);
  assert.equal(s.sessionId, "session-2026-11-01T11-00-def", "the header id is shared by many background sessions, so the file name is the id");
  assert.equal(s.subagent, false);
});

test("discovery finds both kinds, the report prices them, and clients see the project", () => {
  const files = geminiSessionFiles({ home, env: {} });
  assert.equal(files.length, 2);
  assert.deepEqual(geminiSessionFiles({ home: path.join(home, "none"), env: {} }), []);
  const sessions = files.map((f) => parseTranscript(f));
  const sum = summarizeGemini(sessions, { pricing: loadPricing(), now: Date.parse("2026-11-02T00:00:00Z") });
  assert.equal(sum.sessions, 2);
  assert.equal(sum.responses, 3);
  assert.equal(sum.confidence, "derived");
  assert.ok(sum.totalUSD > 0 && sum.byModel[0].model === "gemini-2.5-pro");
  assert.equal(sum.tokens.total, sum.tokens.input + sum.tokens.cacheRead + sum.tokens.output);
  const ev = clientEvents({ codexSessions: sessions, rules: [{ path: "/work/Acme", label: "Acme" }], pricing: loadPricing() });
  assert.ok((ev.get("Acme") || []).length >= 2, "the session in /work/Acme is the client's");
});
