import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeConfigDirs, accountOf, dirOfLog, summarizeAccounts, desktopOwner, planScope } from "../src/accounts.mjs";
import { readAccount, safeLabel } from "../src/collector.mjs";
import { sanitizeAccounts, loadConfig } from "../src/config.mjs";
import { isClaudeLog } from "../src/sources.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-acc-"));
const mk = (...p) => fs.mkdirSync(path.join(home, ...p), { recursive: true });
const write = (rel, o) => fs.writeFileSync(path.join(home, rel), JSON.stringify(o));
mk(".claude", "projects", "-p");
mk(".claude-work", "projects", "-w");
mk(".claude-client_b", "projects", "-c");
mk(".claude-empty"); // no projects folder: not a config folder
mk(".claude-flowish"); // looks similar, nothing in it
mk("elsewhere", "projects", "-e");
write(".claude.json", { oauthAccount: { accountUuid: "acct-default", organizationName: "me@example.com's Organization", organizationType: "claude_pro", billingType: "stripe_subscription", emailAddress: "me@example.com" } });
write(".claude-work/.claude.json", { oauthAccount: { organizationUuid: "org-work", organizationName: "Acme Corp", organizationType: "claude_team", seatTier: "standard" } });
// .claude-client_b has no account file at all

test("config folders: the default, CLAUDE_CONFIG_DIR, ~/.claude-* with a projects folder, and listed ones; not folders without projects", () => {
  const dirs = claudeConfigDirs({ home, env: {}, extra: [path.join(home, "elsewhere"), "relative/path", path.join(home, "nothing")] });
  assert.deepEqual(dirs.map((d) => path.relative(home, d)).sort(), [".claude", ".claude-client_b", ".claude-work", "elsewhere"]);
  assert.ok(claudeConfigDirs({ home, env: { CLAUDE_CONFIG_DIR: path.join(home, "elsewhere") } }).includes(path.join(home, "elsewhere")));
  assert.deepEqual(claudeConfigDirs({ home: path.join(home, "none"), env: {} }), []);
});

test("the default folder's account is in ~/.claude.json beside it; another folder keeps its own and never falls back to the default account", () => {
  const def = accountOf(path.join(home, ".claude"), { home });
  assert.equal(def.label, "personal", "an account named after its email is shown as personal");
  assert.equal(def.plan, "claude_pro · stripe_subscription");
  assert.ok(def.id && def.id !== "me@example.com", "a hash, not the id itself");
  const work = accountOf(path.join(home, ".claude-work"), { home });
  assert.equal(work.label, "Acme Corp");
  assert.equal(work.plan, "claude_team · standard");
  assert.notEqual(work.id, def.id);
  const none = accountOf(path.join(home, ".claude-client_b"), { home });
  assert.equal(none.id, null, "no account file in that folder: unknown, not the default account");
  assert.match(none.label, /unknown/);
});

test("no email reaches an account record, a snapshot label or the output", () => {
  assert.equal(safeLabel("me@example.com's Organization"), "personal");
  assert.equal(safeLabel("Acme Corp"), "Acme Corp");
  assert.equal(safeLabel(""), "personal");
  assert.equal(safeLabel(undefined), "personal");
  const a = readAccount({ env: {}, home });
  assert.doesNotMatch(JSON.stringify(a), /example\.com|me@/);
  assert.doesNotMatch(JSON.stringify(accountOf(path.join(home, ".claude"), { home })), /example\.com|me@/);
});

test("labels you give win, by folder or by account id; they are checked", () => {
  const d = path.join(home, ".claude-work");
  assert.equal(accountOf(d, { home, labels: { [d]: "Client A" } }).label, "Client A");
  const id = accountOf(d, { home }).id;
  const byId = accountOf(d, { home, labels: { [id]: "Work seat" } });
  assert.deepEqual([byId.label, byId.named], ["Work seat", true]);
  assert.deepEqual(sanitizeAccounts({ dirs: ["/ok", "rel", 5], labels: { a: " Name ", b: "", c: 7, d: "x".repeat(61) } }), { dirs: ["/ok"], labels: { a: "Name" } });
  assert.deepEqual(sanitizeAccounts(null), { dirs: [], labels: {} });
});

test("a log belongs to the longest config folder that holds it; Desktop agent sessions and others are listed apart", () => {
  const dirs = [path.join(home, ".claude"), path.join(home, ".claude", "nested"), path.join(home, ".claude-work")];
  assert.equal(dirOfLog(path.join(home, ".claude-work", "projects", "-w", "s.jsonl"), dirs), path.join(home, ".claude-work"), ".claude is not a prefix of .claude-work");
  assert.equal(dirOfLog(path.join(home, ".claude", "nested", "projects", "x", "s.jsonl"), dirs), path.join(home, ".claude", "nested"));
  assert.equal(dirOfLog("/somewhere/else/s.jsonl", dirs), null);
  const now = Date.parse("2026-11-06T12:00:00Z");
  const res = (project, usd, daysAgo, end = "2026-11-05T00:00:00Z") => ({ project, totalCostUSD: usd, end, timeline: [{ t: now - daysAgo * 86400e3, cost: usd }] });
  const sum = summarizeAccounts([
    res(path.join(home, ".claude-work", "projects", "-w"), 40, 2),
    res(path.join(home, ".claude-work", "projects", "-w"), 10, 20),
    res(path.join(home, ".claude", "projects", "-p"), 5, 1),
    res("/x/Claude/local-agent-mode-sessions/a/b/local_c/.claude/projects/-sessions-x", 7, 3),
    res("/tmp/unknown/dir", 1, 1)
  ], [path.join(home, ".claude"), path.join(home, ".claude-work")], { home, now });
  assert.deepEqual(sum.accounts.map((a) => [a.label, a.sessions, a.totalUSD, a.last7DaysUSD]), [["Acme Corp", 2, 50, 40], ["Claude Desktop agent (agent mode)", 1, 7, 7], ["personal", 1, 5, 5], ["Other", 1, 1, 1]]);
  assert.equal(sum.configDirs, 2);
});

test("other config folders' logs count as Claude logs; a project's settings add account names but no folders", () => {
  assert.equal(isClaudeLog("/Users/a/.claude-work/projects/p/s.jsonl"), true);
  assert.equal(isClaudeLog("/Users/a/.claude/projects/p/s.jsonl"), true);
  assert.equal(isClaudeLog("/Users/a/.claude_client/projects/p/s.jsonl"), true);
  assert.equal(isClaudeLog("/Users/a/Documents/projects/p/s.jsonl"), false);
  const g = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-cfg-")), "config.json");
  fs.writeFileSync(g, JSON.stringify({ accounts: { dirs: ["/a"], labels: { x: "Global", y: "Y" } } }));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-proj-"));
  fs.mkdirSync(path.join(proj, ".sparelimit"));
  fs.writeFileSync(path.join(proj, ".sparelimit", "config.json"), JSON.stringify({ accounts: { dirs: ["/b"], labels: { x: "Project" } } }));
  assert.deepEqual(loadConfig({ cwd: proj, globalFile: g }).accounts, { dirs: ["/a"], labels: { x: "Global", y: "Y" } });
});

test("end to end: a second config folder's sessions are found and attributed; labels and folders are set through the command", async () => {
  const { spawnSync } = await import("node:child_process");
  const { ROOT } = await import("./helpers.mjs");
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-e2e-"));
  const line = (id) => JSON.stringify({ type: "assistant", sessionId: id, uuid: id, timestamp: new Date().toISOString(), message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 0, output_tokens: 100 }, content: [] } }) + "\n";
  for (const [dir, id] of [[".claude", "s-main"], [".claude-work", "s-work"]]) {
    fs.mkdirSync(path.join(h, dir, "projects", "-p"), { recursive: true });
    fs.writeFileSync(path.join(h, dir, "projects", "-p", `${id}.jsonl`), line(id));
  }
  fs.writeFileSync(path.join(h, ".claude-work", ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: "org-w", organizationName: "Acme Corp", organizationType: "claude_team" } }));
  const vh = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-state-"));
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...a], { encoding: "utf8", env: { ...process.env, HOME: h, SPARELIMIT_HOME: vh, SPARELIMIT_NO_CACHE: "1" } });
  const j = JSON.parse(run("accounts", "--json").stdout);
  assert.equal(j.configDirs, 2);
  assert.deepEqual(j.accounts.map((a) => [a.label, a.sessions]).sort(), [["Acme Corp", 1], ["api-key or unknown", 1]].sort());
  assert.match(run("accounts", "label", path.join(h, ".claude-work"), "Client", "A").stdout, /now called "Client A"/);
  assert.ok(JSON.parse(run("accounts", "--json").stdout).accounts.some((a) => a.label === "Client A" && a.named));
  assert.equal(run("accounts", "add-dir", "relative").status, 2);
  assert.equal(run("accounts", "add-dir", path.join(h, "no-such")).status, 2);
  assert.equal(run("accounts", "label").status, 2);
  const text = run("accounts").stdout;
  assert.match(text, /SPARELIMIT ACCOUNTS/);
  assert.doesNotMatch(text, /@/);
});

test("Desktop agent-mode sessions are attributed from the path: the account's own config folder when the ids match, else a Desktop account of their own", () => {
  const U1 = "11111111-1111-4111-8111-111111111111";
  const U2 = "22222222-2222-4222-8222-222222222222";
  const U3 = "33333333-3333-4333-8333-333333333333";
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-desk-"));
  fs.mkdirSync(path.join(h, ".claude", "projects"), { recursive: true });
  fs.writeFileSync(path.join(h, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: U1, organizationUuid: U2, organizationName: "Me" } }));
  const logOf = (a, o) => `/x/Claude/local-agent-mode-sessions/${a}/${o}/local_c/.claude/projects/-sessions-x/s.jsonl`;
  assert.deepEqual(desktopOwner(logOf(U1, U2))?.accountUuid, U1);
  assert.equal(desktopOwner("/x/Claude/local-agent-mode-sessions/skills-plugin/abc/local_c/s.jsonl"), null, "not uuid-shaped: unattributed");
  const dirs = [path.join(h, ".claude")];
  const res = (project, usd) => ({ project, totalCostUSD: usd, end: "2026-11-05T00:00:00Z", timeline: [] });
  const sum = summarizeAccounts([res(logOf(U1, U2), 10), res(logOf(U3, U3), 4), res("/x/Claude/local-agent-mode-sessions/skills-plugin/q/local_c/p", 1)], dirs, { home: h });
  assert.deepEqual(sum.accounts.map((a) => [a.label, a.sessions, a.totalUSD]), [["Me", 1, 10], ["Claude Desktop agent (account 33333333)", 1, 4], ["Claude Desktop agent (agent mode)", 1, 1]]);
  const scope = planScope(dirs[0], dirs, { home: h });
  assert.deepEqual([logOf(U1, U2), logOf(U3, U3), "/x/Claude/local-agent-mode-sessions/skills-plugin/q/local_c/p"].map(scope), [true, false, true], "another Desktop account's sessions are not the default account's plan usage");
});

test("Desktop sessions follow the ACCOUNT uuid: another account under the same org folder is not this account's, and this account's other org folders are", () => {
  const U1 = "11111111-1111-4111-8111-111111111111"; // the signed-in account
  const U2 = "22222222-2222-4222-8222-222222222222"; // its organisation
  const U3 = "33333333-3333-4333-8333-333333333333"; // another account
  const U9 = "99999999-9999-4999-8999-999999999999"; // another organisation of the first account
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-desk2-"));
  fs.mkdirSync(path.join(h, ".claude", "projects"), { recursive: true });
  fs.writeFileSync(path.join(h, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: U1, organizationUuid: U2, organizationName: "Me" } }));
  const logOf = (a, o) => `/x/Claude/local-agent-mode-sessions/${a}/${o}/local_c/.claude/projects/-sessions-x/s.jsonl`;
  const dirs = [path.join(h, ".claude")];
  const res = (project, usd) => ({ project, totalCostUSD: usd, end: "2026-11-05T00:00:00Z", timeline: [] });
  const sum = summarizeAccounts([res(logOf(U1, U2), 10), res(logOf(U1, U9), 5), res(logOf(U3, U2), 4)], dirs, { home: h });
  assert.deepEqual(sum.accounts.map((a) => [a.label, a.sessions, a.totalUSD]), [["Me", 2, 15], ["Claude Desktop agent (account 33333333)", 1, 4]], "the same org folder under another account does not make it ours");
  const scope = planScope(dirs[0], dirs, { home: h });
  assert.deepEqual([logOf(U1, U2), logOf(U1, U9), logOf(U3, U2)].map(scope), [true, true, false]);
});
