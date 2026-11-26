import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotFromStatusline, handleStatusline, readAccount } from "../src/collector.mjs";
import { snapshotPath, quotaLogPath } from "../src/state.mjs";
import { fixture, tempSparelimitHome } from "./helpers.mjs";

const payload = fs.readFileSync(fixture("statusline.json"), "utf8");
const SID = JSON.parse(payload).session_id;

test("snapshot carries exact context, cost, quota windows and repo identity", () => {
  const s = snapshotFromStatusline(JSON.parse(payload), { now: 1_800_000_000_000, account: null });
  assert.equal(s.confidence, "exact");
  assert.equal(s.contextPct, 60);
  assert.equal(s.contextTokens, 120000);
  assert.equal(s.costUsd, 3.21);
  assert.deepEqual(s.rateLimits.fiveHour, { pct: 40, resetsAt: 1800000000 });
  assert.deepEqual(s.project.repo, { host: "github.com", owner: "acme", name: "app" });
});

test("missing optional fields (no rate_limits for API users) do not break the snapshot", () => {
  const j = JSON.parse(payload);
  delete j.rate_limits;
  delete j.context_window.used_percentage;
  const s = snapshotFromStatusline(j, { account: null });
  assert.equal(s.rateLimits.fiveHour, null);
  assert.equal(s.contextPct, null);
});

test("handleStatusline persists the snapshot, logs quota history and prints one line", () => {
  tempSparelimitHome();
  const line = handleStatusline(payload, { account: null, now: 1_800_000_000_000 });
  assert.equal(line, "ctx 60% · $3.21 · 5h 40% · 7d 50%");
  assert.equal(JSON.parse(fs.readFileSync(snapshotPath(SID), "utf8")).costUsd, 3.21);
  assert.equal(fs.readFileSync(quotaLogPath(), "utf8").trim().split("\n").length, 1);
  // same quota numbers again: no duplicate history row
  handleStatusline(payload, { account: null, now: 1_800_000_060_000 });
  assert.equal(fs.readFileSync(quotaLogPath(), "utf8").trim().split("\n").length, 1);
});

test("garbage input never throws", () => {
  tempSparelimitHome();
  assert.equal(handleStatusline("not json", { account: null }), "sparelimit");
  assert.equal(handleStatusline("{}", { account: null }), "sparelimit");
});

test("an existing status line can be chained", () => {
  tempSparelimitHome();
  const line = handleStatusline(payload, { account: null, chain: "echo my-existing-line" });
  assert.equal(line, "my-existing-line");
  assert.ok(fs.existsSync(snapshotPath(SID)), "snapshot still written when chaining");
});

test("account identity is hashed; email and names of people are never stored", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-"));
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acc-1", organizationUuid: "org-1", emailAddress: "person@example.com", fullName: "A Person", organizationName: "Acme Agency", organizationType: "claude_team", billingType: "stripe" } }));
  const acct = readAccount({ env: {}, home });
  assert.equal(acct.label, "Acme Agency");
  assert.match(acct.id, /^[0-9a-f]{12}$/);
  const dump = JSON.stringify(acct);
  assert.ok(!dump.includes("person@example.com") && !dump.includes("A Person") && !dump.includes("org-1"));
  // stable across devices for the same org
  assert.equal(readAccount({ env: {}, home }).id, acct.id);
});

test("no account file means an explicit unknown label, not a crash", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-"));
  assert.equal(readAccount({ env: {}, home }).id, null);
});
