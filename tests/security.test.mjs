import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { ROOT, fixture, tempSparelimitHome } from "./helpers.mjs";
import { loadConfig } from "../src/config.mjs";
import { mergePolicy } from "../src/policy.mjs";

tempSparelimitHome();
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sec-home-"));
fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
fs.copyFileSync(fixture("claude-code-session.jsonl"), path.join(home, ".claude", "projects", "p", "s.jsonl"));
process.env.HOME = home;
const work = fs.mkdtempSync(path.join(os.tmpdir(), "sec-cwd-"));
process.chdir(work);
const { startServer } = await import("../src/server.mjs");
const server = startServer(null, null, 0);
await new Promise((r) => (server.listening ? r() : server.once("listening", r)));
const port = server.address().port;
test.after(() => server.close());
const req = (p, headers = {}, method = "GET") => new Promise((resolve, reject) => {
  const r = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => { let body = ""; res.on("data", (d) => (body += d)); res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers })); });
  r.on("error", reject);
  r.end();
});
const own = { host: `127.0.0.1:${port}` };

test("the dashboard answers itself and a typed address", async () => {
  assert.equal((await req("/", own)).status, 200);
  assert.equal((await req("/", { ...own, "sec-fetch-site": "none" })).status, 200);
  assert.equal((await req("/api/live", { ...own, "sec-fetch-site": "same-origin", origin: `http://127.0.0.1:${port}` })).status, 200);
});

test("another website can load, read or trigger nothing", async () => {
  await req("/api/live", own); // writes the snapshot the old bug leaked
  for (const p of ["/live-session.js", "/live-session.json", "/api/live", "/api/sessions", "/api/overview", "/", "/app.js"]) {
    for (const h of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { origin: "https://evil.example" }, { origin: "null" }]) {
      const r = await req(p, { ...own, ...h });
      assert.equal(r.status, 403, `${p} ${JSON.stringify(h)}`);
      assert.doesNotMatch(r.body, /sessionId|__LIVE_SESSION__/);
    }
  }
  for (const h of [{ origin: "https://evil.example" }, { origin: "null" }, { origin: "%%%" }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await req("/api/action/muzzle", { ...own, ...h }, "POST")).status, 403, JSON.stringify(h));
    assert.equal((await req("/api/action/reset", { ...own, ...h }, "POST")).status, 403);
  }
  assert.equal(fs.existsSync(path.join(work, ".sparelimit-muzzle.sh")), false, "nothing was done");
});

test("even a browser that says nothing about where a request came from cannot load the snapshot into another page", async () => {
  const r = await req("/live-session.js", own);
  assert.equal(r.headers["cross-origin-resource-policy"], "same-origin");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.headers["x-frame-options"], "DENY");
});

test("no request stops the server", async () => {
  for (const [p, h, m] of [["/api/action/muzzle", { ...own, origin: "null" }, "POST"], ["//%%", own, "GET"], ["/api/timeline?id=%E0%A4%A", own, "GET"], ["/", { host: "evil.example" }, "GET"], ["/api/action/muzzle", own, "GET"]]) await req(p, h, m).catch(() => {});
  assert.equal((await req("/", own)).status, 200);
});

// ---- a project's own settings file
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "sec-proj-"));
const globalFile = path.join(proj, "global.json");
const write = (global, project) => {
  fs.writeFileSync(globalFile, JSON.stringify(global));
  fs.mkdirSync(path.join(proj, ".sparelimit"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".sparelimit", "config.json"), JSON.stringify(project));
  return loadConfig({ cwd: proj, globalFile });
};

test("a project file cannot switch a check off, raise a limit, ignore a rule, trim output or add folders", () => {
  const c = write({}, {
    policy: { context: { warnPct: null, blockPct: 100 }, loop: { warnAfter: 999, blockAfter: null }, quota: { projectionWarn: false, fiveHourBlockPct: null } },
    budgets: {}, ignore: { rules: ["context.window", "loop.identical_calls"] }, trim: { enabled: true }, accounts: { dirs: ["/etc"] }, playbooks: { enabled: true, rules: [] }
  });
  const p = mergePolicy(c.policy);
  const d = mergePolicy({});
  assert.deepEqual(p, d, "every default stands");
  assert.deepEqual(c.ignore.rules, []);
  assert.equal(c.trim.enabled, false);
  assert.deepEqual(c.accounts.dirs, []);
  assert.equal(c.playbooks.enabled, false);
});

test("a project file can make a check stricter, and never loosens your own setting", () => {
  let c = write({ policy: { context: { warnPct: 50 } }, budgets: { dailyUSD: 40 } }, { policy: { context: { warnPct: 40 }, budget: { hourlyBlockUSD: 5 }, quota: { blockOnEstimated: true } }, budgets: { dailyUSD: 90, weeklyUSD: 100 } });
  const p = mergePolicy(c.policy);
  assert.deepEqual([p.context.warnPct, p.budget.hourlyBlockUSD, p.quota.blockOnEstimated], [40, 5, true]);
  assert.deepEqual(c.budgets, { dailyUSD: 40, weeklyUSD: 100 });
  c = write({ policy: { context: { warnPct: 30 } } }, { policy: { preset: "steady" } });
  assert.equal(mergePolicy(c.policy).context.warnPct, 30, "a preset in a project cannot loosen either");
});

test("the workflows ask for the least permission and pin every action to an exact commit", () => {
  for (const f of ["ci.yml", "pages.yml"]) {
    const t = fs.readFileSync(path.join(ROOT, ".github", "workflows", f), "utf8");
    assert.match(t, /^permissions:/m, f);
    for (const m of t.matchAll(/uses: (\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `${f}: ${m[1]}`);
  }
});
