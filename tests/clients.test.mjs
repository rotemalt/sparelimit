import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { encodeProject, sanitizeClients, clientOf, summarizeClients } from "../src/clients.mjs";
import { loadConfig } from "../src/config.mjs";
import { ROOT } from "./helpers.mjs";

test("a path is encoded the way Claude Code names a project folder: every non-alphanumeric character becomes a dash", () => {
  assert.equal(encodeProject("/Users/dana/Downloads/.Example App"), "-Users-dana-Downloads--Example-App");
  assert.equal(encodeProject("-Users-dana-Downloads-Notes"), "-Users-dana-Downloads-Notes");
});

test("rules are checked: a path must be absolute, text at least 2 characters, a label 1 to 60; bad ones are dropped, good ones kept in order", () => {
  const c = sanitizeClients({ rules: [{ path: "/a/Acme", label: " Acme " }, { path: "rel", label: "X" }, { contains: "x", label: "Short" }, { contains: "beta", label: "" }, { contains: "beta", label: "B".repeat(61) }, { contains: "beta", label: "Beta" }, null, { label: "none" }] });
  assert.deepEqual(c.rules, [{ path: "/a/Acme", label: "Acme" }, { contains: "beta", label: "Beta" }]);
  assert.deepEqual(sanitizeClients(undefined), { rules: [], budgets: {} });
});

test("the first matching rule wins; a path matches its folder and what starts the same way; text is not case-sensitive; nothing matching is null", () => {
  const rules = [{ contains: "acme-internal", label: "Internal" }, { path: "/Users/me/Clients/Acme", label: "Acme" }, { contains: "ZETA", label: "Zeta" }];
  assert.equal(clientOf("-Users-me-Clients-Acme", rules), "Acme");
  assert.equal(clientOf("-Users-me-Clients-Acme-site", rules), "Acme", "also what starts the same way: a path cannot be told from a longer name once encoded");
  assert.equal(clientOf("-Users-me-Clients-Acme-internal-tools", rules), "Internal", "order decides");
  assert.equal(clientOf("-Users-me-work-zeta-app", rules), "Zeta");
  assert.equal(clientOf("-Users-me-Other", rules), null);
  assert.equal(clientOf(undefined, rules), null);
});

test("the report groups sessions by client with total, 30 and 7 days; unassigned comes last with its largest projects", () => {
  const now = Date.parse("2026-11-06T12:00:00Z");
  const res = (project, usd, daysAgo) => ({ project: `/home/.claude/projects/${project}`, totalCostUSD: usd, timeline: [{ t: now - daysAgo * 86400e3, cost: usd }] });
  const sum = summarizeClients([res("-x-Acme-a", 30, 2), res("-x-Acme-b", 20, 20), res("-x-Big-unmapped", 500, 1), res("-x-Small-unmapped", 5, 40)], [{ contains: "acme", label: "Acme" }], { now });
  assert.deepEqual(sum.clients.map((c) => [c.label, c.sessions, c.projects, c.totalUSD, c.last30DaysUSD, c.last7DaysUSD]), [["Acme", 2, 2, 50, 50, 30], ["Unassigned", 2, 2, 505, 500, 500]]);
  assert.deepEqual(sum.unassignedTop.map((u) => u.project), ["-x-Big-unmapped", "-x-Small-unmapped"]);
  assert.equal(sum.rules, 1);
});

test("settings: the project's rules come before the global ones; sparelimit clients add writes a validated rule and the report uses it", () => {
  const g = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-cl-")), "config.json");
  fs.writeFileSync(g, JSON.stringify({ clients: { rules: [{ contains: "global", label: "G" }] } }));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-clp-"));
  fs.mkdirSync(path.join(proj, ".sparelimit"));
  fs.writeFileSync(path.join(proj, ".sparelimit", "config.json"), JSON.stringify({ clients: { rules: [{ contains: "local", label: "L" }] } }));
  assert.deepEqual(loadConfig({ cwd: proj, globalFile: g }).clients.rules.map((r) => r.label), ["L", "G"]);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-cli-"));
  fs.mkdirSync(path.join(home, ".claude", "projects", "-x-Acme-site"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "projects", "-x-Acme-site", "s.jsonl"), JSON.stringify({ type: "assistant", sessionId: "s", uuid: "a", timestamp: new Date().toISOString(), message: { id: "m", model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 0, output_tokens: 100 }, content: [] } }) + "\n");
  const vh = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-state-"));
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...a], { encoding: "utf8", env: { ...process.env, HOME: home, SPARELIMIT_HOME: vh, SPARELIMIT_NO_CACHE: "1" } });
  assert.equal(run("clients", "add", "--contains=acme", "Acme", "Ltd").status, 0);
  assert.equal(run("clients", "add", "relative/path", "X").status, 2);
  assert.equal(run("clients", "add", "--contains=a", "X").status, 2);
  assert.equal(run("clients", "add").status, 2);
  const j = JSON.parse(run("clients", "--json").stdout);
  assert.deepEqual(j.clients.map((c) => [c.label, c.sessions]), [["Acme Ltd", 1]]);
  assert.equal(j.rules, 1);
});

import { sanitizeClientBudgets, clientEvents, checkClientBudgets } from "../src/clients.mjs";
import { buildClientReport, renderClientReportHtml } from "../src/clientreport.mjs";
import { parseCodex } from "../src/adapters/codex.mjs";
import { loadPricing } from "../src/pricing.mjs";

test("client budgets are checked: positive numbers only, a client with none left is dropped, names are limited", () => {
  assert.deepEqual(sanitizeClientBudgets({ Acme: { monthlyUSD: 400, weeklyUSD: -1, dailyUSD: "9", other: 5 }, Empty: { monthlyUSD: 0 }, "": { monthlyUSD: 5 }, [`${"x".repeat(61)}`]: { monthlyUSD: 5 }, Bad: 7 }), { Acme: { monthlyUSD: 400 } });
  assert.deepEqual(sanitizeClientBudgets(null), {});
});

test("events per client combine Claude Code and Codex; sessions no rule matches are left out; budgets are checked on the local calendar", () => {
  const now = new Date(2026, 10, 4, 15, 0).getTime(); // Wednesday 4 November 2026, local
  const claude = (dir, daysAgo, cost) => ({ project: `/h/.claude/projects/${dir}`, timeline: [{ t: now - daysAgo * 86400e3, cost }] });
  const cx = parseCodex("/x/rollout-1.jsonl", [
    { type: "session_meta", timestamp: "2026-11-04T00:00:00Z", payload: { id: "c", cli_version: "1", cwd: "/Users/me/Clients/Acme" } },
    { type: "turn_context", payload: { model: "gpt-5" } },
    { type: "token_usage_record", timestamp: new Date(now - 3600e3).toISOString(), payload: { response_id: "r", usage: { input_tokens: 4e6, output_tokens: 0 } } }
  ]);
  const rules = [{ contains: "acme", label: "Acme" }];
  const ev = clientEvents({ claudeResults: [claude("-x-Acme-site", 0.01, 6), claude("-x-Acme-site", 1, 5), claude("-x-Acme-site", 40, 100), claude("-x-Other", 0.01, 999)], codexSessions: [cx], rules, pricing: loadPricing() });
  assert.deepEqual([...ev.keys()], ["Acme"], "Other has no rule, so it has no budget to check");
  const codexCost = ev.get("Acme").find((e) => e.cost < 6 && e.t > now - 7200e3 && e.cost !== 6).cost;
  const r = checkClientBudgets(ev, { Acme: { dailyUSD: 6, weeklyUSD: 50, monthlyUSD: 1000 }, Nobody: { monthlyUSD: 5 } }, now);
  const acme = r.clients.find((c) => c.label === "Acme");
  assert.equal(acme.rows.find((x) => x.key === "dailyUSD").spentUSD, Math.round((6 + codexCost) * 100) / 100, "today: the Claude response and the Codex one");
  assert.equal(acme.rows.find((x) => x.key === "dailyUSD").over, true, "6 + Codex is more than 6");
  assert.equal(acme.rows.find((x) => x.key === "weeklyUSD").over, false);
  assert.ok(acme.rows.find((x) => x.key === "monthlyUSD").spentUSD > 11, "the 40-day-old 100 is outside the month");
  assert.deepEqual(acme.over, ["today"]);
  assert.deepEqual(r.clients.find((c) => c.label === "Nobody").rows.map((x) => x.spentUSD), [0], "a client with a budget and no spend is at 0, not missing");
  assert.equal(r.overAny, true);
  assert.equal(checkClientBudgets(ev, {}, now).clients.length, 0);
});

test("the report shows the budget only when given it; sparelimit clients budget / --check set, show and exit 1 when over; adding a rule keeps the budgets", () => {
  const rep = buildClientReport({ rules: [], client: "Acme", now: Date.now(), pricing: loadPricing(), budget: [{ period: "this month", spentUSD: 250, limitUSD: 400, pct: 63, over: false }] });
  assert.match(renderClientReportHtml(rep), /<h2>Budget<\/h2>[\s\S]*\$250\.00[\s\S]*\$400\.00[\s\S]*63%/);
  assert.doesNotMatch(renderClientReportHtml(buildClientReport({ rules: [], client: "Acme", now: Date.now(), pricing: loadPricing() })), /<h2>Budget/);

  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-cb-"));
  fs.mkdirSync(path.join(home, ".claude", "projects", "-x-Acme-site"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "projects", "-x-Acme-site", "s.jsonl"), JSON.stringify({ type: "assistant", sessionId: "s", uuid: "a", timestamp: new Date().toISOString(), message: { id: "m", model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 0, output_tokens: 100 }, content: [] } }) + "\n");
  const vh = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-state-"));
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...a], { encoding: "utf8", env: { ...process.env, HOME: home, SPARELIMIT_HOME: vh, SPARELIMIT_NO_CACHE: "1", CODEX_HOME: path.join(home, "none") } });
  assert.equal(run("clients", "budget", "Acme", "monthly=1000").status, 2, "no rule, so no such client yet");
  run("clients", "add", "--contains=acme", "Acme");
  assert.equal(run("clients", "budget", "Acme", "daily=abc").status, 2);
  assert.equal(run("clients", "budget", "Acme").status, 2, "nothing to set");
  assert.match(run("clients", "budget", "Acme", "daily=0.001", "monthly=1000").stdout, /daily \$0\.001, monthly \$1000/);
  const over = run("clients", "--check");
  assert.equal(over.status, 1, "today's spend is over $0.001");
  assert.match(over.stdout, /OVER/);
  assert.match(over.stderr, /Over budget: Acme \(today\)/);
  const j = JSON.parse(run("clients", "--check", "--json").stdout);
  assert.deepEqual(j.clients[0].over, ["today"]);
  run("clients", "add", "--contains=beta", "Beta");
  assert.match(run("clients", "budget", "Acme", "daily=1000").stdout, /daily \$1000/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(vh, "config.json"), "utf8")).clients.budgets.Acme.monthlyUSD, 1000, "adding a rule did not drop the budgets");
  assert.equal(run("clients", "--check").status, 0, "under budget");
  run("clients", "budget", "Acme", "--clear");
  assert.match(run("clients", "--check").stdout, /No client budgets set/);
});
