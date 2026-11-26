import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildClientReport, renderClientReportHtml, weekStart } from "../src/clientreport.mjs";
import { parseCodex } from "../src/adapters/codex.mjs";
import { loadPricing } from "../src/pricing.mjs";
import { ROOT } from "./helpers.mjs";

const NOW = Date.parse("2026-11-06T12:00:00Z"); // a Friday
const DAY = 86400e3;
const rules = [{ contains: "acme", label: "Acme" }, { contains: "beta", label: "Beta Ltd" }];
const claude = (dir, id, events) => ({ sessionId: id, project: `/home/u/.claude/projects/${dir}`, timeline: events.map(([daysAgo, cost]) => ({ t: NOW - daysAgo * DAY, cost })) });
const codex = (cwd, id, events, sub = false) => parseCodex(`/x/rollout-${id}.jsonl`, [
  { type: "session_meta", timestamp: "2026-11-01T00:00:00Z", payload: { id, cli_version: "0.1", cwd, source: sub ? { subagent: {} } : "cli" } },
  { type: "turn_context", payload: { model: "gpt-5" } },
  ...events.map(([daysAgo, tokens], i) => ({ type: "token_usage_record", timestamp: new Date(NOW - daysAgo * DAY).toISOString(), ordinal: i, payload: { response_id: `${id}-${i}`, usage: { input_tokens: tokens, output_tokens: 0 } } }))
]);

test("weeks start on Monday 00:00 UTC", () => {
  assert.equal(new Date(weekStart(Date.parse("2026-11-06T12:00:00Z"))).toISOString(), "2026-11-02T00:00:00.000Z");
  assert.equal(new Date(weekStart(Date.parse("2026-11-08T23:59:00Z"))).toISOString(), "2026-11-02T00:00:00.000Z", "Sunday is the last day of the week");
  assert.equal(new Date(weekStart(Date.parse("2026-11-09T00:00:00Z"))).toISOString(), "2026-11-09T00:00:00.000Z");
});

test("only the client's projects and only the period count; each project, week and total adds up", () => {
  const r = buildClientReport({
    claudeResults: [claude("-x-Acme-site", "a1", [[1, 10], [3, 5], [45, 100]]), claude("-x-Acme-api", "a2", [[2, 2]]), claude("-x-Beta-app", "b1", [[1, 999]]), claude("-x-Other", "o1", [[1, 999]])],
    rules, client: "Acme", days: 30, now: NOW, pricing: loadPricing()
  });
  assert.equal(r.totalUSD, 17, "10 + 5 + 2; the 45-day-old 100 is outside 30 days, Beta and Other are other clients");
  assert.equal(r.sessions, 2, "a1 and a2 were active in the period");
  assert.equal(r.projects, 2);
  assert.deepEqual(r.topProjects.map((p) => [p.project, p.usd, p.agents]), [["-x-Acme-site", 15, ["claude"]], ["-x-Acme-api", 2, ["claude"]]]);
  assert.equal(r.weeks.reduce((n, w) => n + w.usd, 0), 17);
  assert.deepEqual([r.from, r.to], ["2026-10-07", "2026-11-06"]);
  assert.equal(r.topProjects[0].sharePct, 88.2);
});

test("Codex sessions are matched by the working directory they record; a subagent's spend counts but it is not a session of its own", () => {
  const sessions = [codex("/Users/me/Clients/Acme", "c1", [[1, 4e6]]), codex("/Users/me/Clients/Acme", "c1-sub", [[1, 4e6]], true), codex("/Users/me/Clients/Beta", "c2", [[1, 4e6]])];
  const r = buildClientReport({ codexSessions: sessions, rules, client: "Acme", days: 30, now: NOW, pricing: loadPricing() });
  assert.ok(r.byAgent.codex.usd > 0);
  assert.equal(r.byAgent.codex.sessions, 1, "the subagent is part of the conversation");
  assert.equal(r.byAgent.claude.usd, 0);
  assert.deepEqual(r.topProjects.map((p) => [p.project, p.agents]), [["Acme", ["codex"]]]);
  const both = buildClientReport({ claudeResults: [claude("-x-Acme-site", "a1", [[1, 10]])], codexSessions: sessions, rules, client: "Acme", now: NOW, pricing: loadPricing() });
  assert.equal(both.sessions, 2);
  assert.ok(Math.abs(both.totalUSD - (10 + both.byAgent.codex.usd)) < 0.01, "both agents in one total");
});

test("--hide-projects leaves project names out of the data and the page; a quiet period still renders", () => {
  const r = buildClientReport({ claudeResults: [claude("-x-Acme-secret-project", "a1", [[1, 10]])], rules, client: "Acme", now: NOW, pricing: loadPricing(), hideProjects: true });
  assert.deepEqual(r.topProjects, []);
  assert.doesNotMatch(JSON.stringify(r) + renderClientReportHtml(r), /secret-project/);
  assert.match(renderClientReportHtml(r), /Project names are left out/);
  const quiet = buildClientReport({ rules, client: "Acme", now: NOW, pricing: loadPricing() });
  assert.equal(quiet.totalUSD, 0);
  assert.match(renderClientReportHtml(quiet), /No activity in this period/);
});

test("the page is escaped, self-contained and free of paths, prompts and scripts", () => {
  const r = buildClientReport({ claudeResults: [claude("-x-Acme-<img src=x onerror=alert(1)>", "a1", [[1, 10]])], rules: [{ contains: "acme", label: 'Acme <script>alert("x")</script>' }], client: 'Acme <script>alert("x")</script>', now: NOW, pricing: loadPricing() });
  const html = renderClientReportHtml(r);
  assert.doesNotMatch(html, /<script|<img /, "no real tag comes from the data");
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/, "shown as text");
  assert.doesNotMatch(html, /\/home\/|\/Users\/|\.jsonl|https?:\/\//, "no path, no log file name, no external resource");
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /not what anyone was billed/);
  assert.match(html, /<svg viewBox/);
});

test("small shares read '<1%', not '0%'", () => {
  const r = buildClientReport({ claudeResults: [claude("-x-Acme-big", "a1", [[1, 1000]]), claude("-x-Acme-tiny", "a2", [[1, 1]])], rules, client: "Acme", now: NOW, pricing: loadPricing() });
  assert.match(renderClientReportHtml(r), /&lt;1%/);
});

test("sparelimit report: refuses with no client, an unknown client or no rules; writes one file named for the client and takes both flag forms", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-rep-"));
  fs.mkdirSync(path.join(home, ".claude", "projects", "-x-Acme-site"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "projects", "-x-Acme-site", "s.jsonl"), JSON.stringify({ type: "assistant", sessionId: "s", uuid: "a", timestamp: new Date().toISOString(), message: { id: "m", model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 0, output_tokens: 100 }, content: [] } }) + "\n");
  const vh = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-state-"));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-out-"));
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...a], { encoding: "utf8", env: { ...process.env, HOME: home, SPARELIMIT_HOME: vh, SPARELIMIT_NO_CACHE: "1", CODEX_HOME: path.join(home, "no-codex") } });
  assert.equal(run("report").status, 2);
  assert.match(run("report", "--client", "Acme").stderr, /Write a rule first/, "no rules yet");
  run("clients", "add", "--contains=acme", "Acme Ltd");
  assert.equal(run("report", "--client", "Nobody").status, 2);
  const a = run("report", "--client", "Acme Ltd", `--out=${out}`);
  assert.equal(a.status, 0, a.stderr);
  assert.deepEqual(fs.readdirSync(out), ["sparelimit-report-acme-ltd.html"]);
  const html = fs.readFileSync(path.join(out, "sparelimit-report-acme-ltd.html"), "utf8");
  assert.match(html, /<h1>Acme Ltd<\/h1>/);
  assert.doesNotMatch(html, /\/tmp\/|sparelimit-rep-/);
  const j = JSON.parse(run("report", "--client=Acme Ltd", "--days=7", "--json").stdout);
  assert.equal(j.periodDays, 7);
  assert.equal(j.sessions, 1);
});
