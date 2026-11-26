import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeSetup, sectionsOf, recommend, usedMcpServers } from "../src/setupweight.mjs";

const claudeMd = ["Contents of /home/u/CLAUDE.md (project instructions):", ...Array.from({ length: 230 }, (_, i) => (i % 40 === 0 ? `## Heading ${i}` : `rule ${i}`))].join("\n");
const userMsg = `<system-reminder>\nCodebase and user instructions are shown below.\n\n${claudeMd}\n</system-reminder>\nuser text`;
const sysMsg = [
  "# Environment", "cwd: /x", "", "# MCP Server Instructions", "", "## alpha", ...Array.from({ length: 80 }, () => "use alpha carefully and always"), "## beta", "short",
  "", "The following skills are available for use with the Skill tool:", ...Array.from({ length: 12 }, (_, i) => `- skill-${i}: does thing ${i}`),
  "", "Available agent types for the Agent tool:", "- coder: writes code", "- tester: tests"
].join("\n");
const deferred = ["The following deferred tools are now available via ToolSearch.", "ToolA", "ToolB", "ToolC"].join("\n");

function sessionFile(extra = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-setup-"));
  const file = path.join(dir, "s.jsonl");
  const tools = [
    { name: "Read", description: "x".repeat(400), input_schema: {} },
    { name: "mcp__alpha__do", description: "y".repeat(8000), input_schema: {} },
    { name: "mcp__beta__do", description: "z".repeat(300), input_schema: {} }
  ];
  const lines = [
    { type: "api-request-shape", shape: { system: [{ type: "text", text: "You are Claude Code." }, { type: "text", text: "s".repeat(3000) }], tools } },
    { type: "api-request-blob", hash: "h1", message: { role: "user", content: [{ type: "text", text: userMsg }] } },
    { type: "api-request-blob", hash: "h2", message: { role: "system", content: [{ type: "text", text: sysMsg }] } },
    { type: "api-request-blob", hash: "h3", message: { role: "system", content: [{ type: "text", text: deferred }] } },
    { type: "api-request", id: "r1", tail: ["h1", "h2", "h3"] },
    ...extra
  ];
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return file;
}

test("sections follow Claude Code's own markers: a CLAUDE.md stays one block even with its own headings", () => {
  const s = sectionsOf(userMsg);
  const md = s.filter((x) => x.kind === "Your instructions (CLAUDE.md files)");
  assert.equal(md.length, 1);
  assert.equal(md[0].label, "/home/u/CLAUDE.md");
  assert.ok(md[0].lines > 200);
});

test("setup report itemizes tools by server, listings with counts, and instruction files", () => {
  const r = analyzeSetup(sessionFile());
  assert.equal(r.available, true);
  assert.equal(r.tools.count, 3);
  assert.equal(r.tools.groups[0].server, "alpha"); // the heaviest group
  assert.equal(r.counts.skills, 12);
  assert.equal(r.counts.agentTypes, 2);
  assert.equal(r.counts.deferredTools, 3);
  assert.ok(r.byKind["MCP server instructions"] > 0);
  assert.equal(r.claudeMdFiles[0].file, "/home/u/CLAUDE.md");
  assert.ok(r.totals.tokens > 2000);
});

test("recommendations name unused MCP servers and over-long instruction files, with the numbers", () => {
  const r = analyzeSetup(sessionFile());
  const recs = recommend(r, { beta: 4 }).map((x) => x.text);
  assert.ok(recs.some((t) => /MCP server "alpha"/.test(t) && /not called/.test(t)));
  assert.ok(!recs.some((t) => /MCP server "beta"/.test(t)));
  assert.ok(recs.some((t) => /CLAUDE\.md is ~/.test(t) || /\/home\/u\/CLAUDE\.md is/.test(t)));
  assert.ok(!recommend(r, { alpha: 3, beta: 1 }).some((x) => /MCP server "alpha"/.test(x.text)), "used servers are not flagged");
});

test("MCP usage is counted from tool calls across sessions", () => {
  const call = (name) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name, input: {} }] } });
  const f = sessionFile([call("mcp__alpha__do"), call("mcp__alpha__do"), call("Read")]);
  assert.deepEqual(usedMcpServers([f]), { alpha: 2 });
});

test("logs without request-shape records are reported as unavailable, not guessed", () => {
  const f = path.join(os.tmpdir(), `sparelimit-old-${process.pid}.jsonl`);
  fs.writeFileSync(f, '{"type":"user","message":{"content":"hi"}}\n');
  const r = analyzeSetup(f);
  assert.equal(r.available, false);
  assert.match(r.reason, /older Claude Code/);
  assert.deepEqual(recommend(r), []);
  fs.unlinkSync(f);
});
