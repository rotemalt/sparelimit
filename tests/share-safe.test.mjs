import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, fixture } from "./helpers.mjs";
import { scan } from "../src/safeshare.mjs";
import { shareLedger, shareWeek } from "../src/shareview.mjs";

/**
 * Every output that may be posted has a share-safe form, and the scanner that `sparelimit safe-to-share` uses finds nothing in it. The home here has
 * a user name, a project folder and an audit log with exact times and a session id, so a leak would show.
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-share-"));
const project = path.join(home, ".claude", "projects", "-Users-dana-secretproject");
fs.mkdirSync(project, { recursive: true });
fs.copyFileSync(fixture("claude-code-session.jsonl"), path.join(project, "11111111-1111-1111-1111-111111111111.jsonl"));
const sparelimit = path.join(home, ".sparelimit");
fs.mkdirSync(sparelimit, { recursive: true });
const now = Date.now();
const rows = [60, 50, 40].map((m, i) => ({ t: new Date(now - m * 60e3 - i * 1234).toISOString(), kind: "coach", rule: "context.reset", sessionId: "11111111-1111-1111-1111-111111111111", evidence: {} }));
fs.writeFileSync(path.join(sparelimit, "audit.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { encoding: "utf8", timeout: 60000, cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, SPARELIMIT_HOME: sparelimit, SPARELIMIT_NO_CACHE: "1", SPARELIMIT_NO_REFRESH: "1" } });

test("without --share the ledger and the summary carry exact times and a session id (so the test would catch a leak)", () => {
  const l = run("ledger", "--json");
  assert.ok(scan(l.stdout).some((f) => f.kind === "exact time"), "the plain ledger has exact times");
  assert.ok(scan(l.stdout).some((f) => f.kind === "session id"), "and a session id");
});

for (const args of [["week", "--days=0"], ["week", "--days=0", "--json"], ["ledger"], ["ledger", "--json"]]) {
  test(`sparelimit ${args.join(" ")} --share: nothing for the scanner to find, and it says so`, () => {
    const r = run(...args, "--share");
    assert.equal(r.status, 0, r.stderr.slice(0, 300));
    assert.deepEqual(scan(r.stdout, { names: ["dana", "secretproject", os.userInfo().username] }), [], r.stdout.slice(0, 300));
    assert.match(r.stderr, /Share check: .* has no home path, email, session id, exact time/);
    if (args.includes("--json")) assert.doesNotThrow(() => JSON.parse(r.stdout), "stdout stays pure JSON");
  });
}

test("sparelimit card --share writes a picture and a page the scanner finds nothing in, and tells you to look at the picture", () => {
  const out = path.join(home, "card-out");
  const r = run("card", "--share", `--out=${out}`);
  assert.equal(r.status, 0, r.stderr.slice(0, 300));
  for (const f of ["sparelimit-card.svg", "sparelimit-card.html"]) assert.deepEqual(scan(fs.readFileSync(path.join(out, f), "utf8"), { names: ["dana", "secretproject"] }), [], f);
  assert.match(r.stderr, /look at it once at full size/);
});

test("the share form keeps every number and drops only times and session ids", () => {
  const ledger = { totals: { interventions: 1 }, entries: [{ at: "2026-11-05T14:32:48.462Z", sessionId: "afc6ab9d-27b9-4427-88ab-7f1e73bdd350", status: "counted", savingUSD: 4.67, family: "quota" }], note: "n" };
  const s = shareLedger(ledger);
  assert.equal(s.entries[0].at, "2026-11-05");
  assert.equal("sessionId" in s.entries[0], false);
  assert.equal(s.entries[0].savingUSD, 4.67);
  assert.deepEqual(s.totals, ledger.totals);
  const w = shareWeek({ from: "2026-11-19T09:12:00.000Z", to: "2026-11-26T09:12:00.000Z", alerts: { value: 3 } });
  assert.deepEqual([w.from, w.to, w.alerts.value], ["2026-11-19", "2026-11-26", 3]);
});

test("docs/SCREENSHOTS.md is there and carries the rule", () => {
  const t = fs.readFileSync(path.join(ROOT, "docs", "SCREENSHOTS.md"), "utf8");
  for (const must of [/full size/i, /solid block/i, /never blur/i, /never change a number/i, /command and the date/i, /dashboard/i]) assert.match(t, must);
});
