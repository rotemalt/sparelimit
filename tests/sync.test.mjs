import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tempSparelimitHome } from "./helpers.mjs";
import { loadPricing } from "../src/pricing.mjs";
import { buildDeviceFile, mergeDevices, readDeviceFiles, thisDevice, writeDeviceFile, SYNC_FORMAT } from "../src/sync.mjs";

tempSparelimitHome();
const pricing = loadPricing();
const SECRET_PROMPT = "please fix the billing bug in ACME-SECRET-PROJECT";
const SECRET_PATH = "/Users/someone/clients/acme-secret/src/billing.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-sync-home-"));
fs.mkdirSync(path.join(home, ".claude", "projects", "-p"), { recursive: true });
fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "acct-1", organizationName: "Acme Corp", organizationType: "claude_team" } }));
const dirs = [path.join(home, ".claude")];
const logFile = path.join(home, ".claude", "projects", "-p", "sess-1.jsonl");

const ev = (ts, over = {}) => ({ id: `m-${ts}`, ts, model: "claude-sonnet-4-5", isSidechain: false, usage: { input: 1000, cacheRead: 50000, cacheWrite5m: 2000, cacheWrite1h: 500, output: 800 }, context: 53500, tools: ["Read"], confidence: "derived", ...over });
/** a session that holds text and paths a sync file must never carry */
const session = (events) => ({
  agent: "claude-code",
  sessionId: "session-id-12345",
  transcriptPath: logFile,
  projectDir: path.dirname(SECRET_PATH),
  events,
  userTurns: [{ text: SECRET_PROMPT, createdAt: events[0].ts }],
  commandResults: [{ command: `cat ${SECRET_PATH}`, ok: true, summary: SECRET_PROMPT }],
  fileTouches: [{ file: SECRET_PATH, kind: "read" }],
  raw: {}
});

const device = (id, name) => ({ id, name });
const A = "aaaaaaaaaaaaaaaa";
const B = "bbbbbbbbbbbbbbbb";

test("a device file holds day, account, model, token classes and dollars, summed per day; UTC days", () => {
  const f = buildDeviceFile([{ filePath: logFile, session: session([ev("2026-11-01T10:00:00Z"), ev("2026-11-01T23:30:00Z"), ev("2026-11-02T00:10:00Z")]) }], { pricing, dirs, home, device: device(A, "Laptop") });
  assert.equal(f.format, SYNC_FORMAT);
  assert.equal(f.rows.length, 2, "two UTC days, one account, one model");
  const d1 = f.rows.find((r) => r.day === "2026-11-01");
  assert.equal(d1.input, 2000);
  assert.equal(d1.cacheRead, 100000);
  assert.equal(d1.cacheWrite, 5000, "5-minute and 1-hour cache writes are one class");
  assert.equal(d1.output, 1600);
  assert.ok(d1.usd > 0);
  assert.deepEqual(Object.values(f.accounts), ["Acme Corp"]);
});

test("the file carries no prompt, no file path, no project name and no session id (checked against a session that has all of them)", () => {
  const f = buildDeviceFile([{ filePath: logFile, session: session([ev("2026-11-01T10:00:00Z")]) }], { pricing, dirs, home, device: device(A, "Laptop") });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-sync-dir-"));
  const out = fs.readFileSync(writeDeviceFile(dir, f), "utf8");
  for (const leak of [SECRET_PROMPT, "ACME-SECRET-PROJECT", "acme-secret", "billing.ts", "/Users/someone", "session-id-12345", "sess-1", logFile, home]) assert.ok(!out.includes(leak), `must not contain ${leak}`);
  assert.deepEqual(Object.keys(f).sort(), ["accounts", "device", "format", "generatedAt", "kind", "rows"]);
  assert.deepEqual(Object.keys(f.rows[0]).sort(), ["account", "cacheRead", "cacheWrite", "day", "input", "model", "output", "usd"]);
});

test("two devices merge to the right totals, and the same account on both is one row", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-sync-dir-"));
  const one = buildDeviceFile([{ filePath: logFile, session: session([ev("2026-11-01T10:00:00Z"), ev("2026-11-02T10:00:00Z")]) }], { pricing, dirs, home, device: device(A, "Laptop") });
  const two = buildDeviceFile([{ filePath: logFile, session: session([ev("2026-11-02T12:00:00Z")]) }], { pricing, dirs, home, device: device(B, "Desktop") });
  writeDeviceFile(dir, one);
  writeDeviceFile(dir, two);
  const { devices, skipped } = readDeviceFiles(dir);
  assert.equal(skipped.length, 0);
  assert.equal(devices.length, 2);
  const v = mergeDevices(devices, { days: 30, now: Date.parse("2026-11-05T00:00:00Z") });
  const each = one.rows[0].usd;
  assert.equal(v.totalUSD, Math.round(3 * each * 100) / 100);
  assert.equal(v.daily.length, 2);
  assert.equal(v.daily.find((d) => d.day === "2026-11-02").usd, Math.round(2 * each * 100) / 100);
  assert.equal(v.accounts.length, 1, "one account across two devices");
  assert.equal(v.accounts[0].label, "Acme Corp");
  assert.deepEqual(v.devices.map((d) => d.name).sort(), ["Desktop", "Laptop"]);
  assert.equal(v.totalTokens, 3 * (1000 + 50000 + 2500 + 800));
});

test("days outside the window are left out of the view", () => {
  const f = buildDeviceFile([{ filePath: logFile, session: session([ev("2026-09-01T10:00:00Z"), ev("2026-11-04T10:00:00Z")]) }], { pricing, dirs, home, device: device(A, "Laptop") });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-sync-dir-"));
  writeDeviceFile(dir, f);
  const v = mergeDevices(readDeviceFiles(dir).devices, { days: 7, now: Date.parse("2026-11-05T00:00:00Z") });
  assert.deepEqual(v.daily.map((d) => d.day), ["2026-11-04"]);
});

test("a corrupt, newer-format, foreign or mismatched file is skipped with a message and the rest still merge", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-sync-dir-"));
  const good = buildDeviceFile([{ filePath: logFile, session: session([ev("2026-11-01T10:00:00Z")]) }], { pricing, dirs, home, device: device(A, "Laptop") });
  writeDeviceFile(dir, good);
  fs.writeFileSync(path.join(dir, `sparelimit-sync-${B}.json`), '{"kind":"sparelimit-sync","format":1,"rows":[');
  fs.writeFileSync(path.join(dir, "sparelimit-sync-cccccccccccccccc.json"), JSON.stringify({ ...good, format: SYNC_FORMAT + 1, device: device("cccccccccccccccc", "Future") }));
  fs.writeFileSync(path.join(dir, "sparelimit-sync-dddddddddddddddd.json"), JSON.stringify({ hello: "world" }));
  fs.writeFileSync(path.join(dir, "sparelimit-sync-eeeeeeeeeeeeeeee.json"), JSON.stringify({ ...good, device: device("ffffffffffffffff", "Liar") }));
  fs.writeFileSync(path.join(dir, "sparelimit-sync-notes.json"), "{}");
  fs.writeFileSync(path.join(dir, "unrelated.txt"), "not ours");
  const { devices, skipped } = readDeviceFiles(dir);
  assert.deepEqual(devices.map((d) => d.name), ["Laptop"]);
  const why = Object.fromEntries(skipped.map((s) => [s.file, s.reason]));
  assert.match(why[`sparelimit-sync-${B}.json`], /not valid JSON/);
  assert.match(why["sparelimit-sync-cccccccccccccccc.json"], /newer version.*update Sparelimit/);
  assert.match(why["sparelimit-sync-dddddddddddddddd.json"], /not a Sparelimit sync file/);
  assert.match(why["sparelimit-sync-eeeeeeeeeeeeeeee.json"], /does not match the file name/);
  assert.match(why["sparelimit-sync-notes.json"], /not a device file/);
  assert.equal(Object.keys(why).length, 5, "unrelated files are ignored without a message");
  assert.equal(mergeDevices(devices).devices.length, 1);
});

test("a file from another device keeps only the known fields: extra text and bad numbers do not get through", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-sync-dir-"));
  const hostile = {
    kind: "sparelimit-sync", format: 1, device: { id: B, name: "Hostile\u0007".repeat(20), prompt: SECRET_PROMPT }, generatedAt: "2026-11-03T00:00:00Z",
    accounts: { x: "Acct" }, secret: SECRET_PROMPT,
    rows: [
      { day: "2026-11-03", account: "x", model: "m", input: -5, cacheRead: "9", cacheWrite: Infinity, output: 10, usd: 1.5, prompt: SECRET_PROMPT, path: SECRET_PATH },
      { day: "not-a-day", account: "x", model: "m", usd: 99 },
      null
    ]
  };
  fs.writeFileSync(path.join(dir, `sparelimit-sync-${B}.json`), JSON.stringify(hostile));
  const { devices } = readDeviceFiles(dir);
  assert.equal(devices.length, 1);
  assert.equal(devices[0].rows.length, 1, "a row with a bad day is dropped");
  assert.deepEqual(devices[0].rows[0], { day: "2026-11-03", account: "x", model: "m", input: 0, cacheRead: 0, cacheWrite: 0, output: 10, usd: 1.5 });
  assert.ok(devices[0].name.length <= 40 && !/\u0007/.test(devices[0].name));
  assert.ok(!JSON.stringify(devices).includes(SECRET_PROMPT));
});

test("a folder that does not exist or is empty gives an empty view, not a crash", () => {
  assert.deepEqual(readDeviceFiles(path.join(os.tmpdir(), "sparelimit-no-such-folder-xyz")).devices, []);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-sync-dir-"));
  const v = mergeDevices(readDeviceFiles(empty).devices);
  assert.equal(v.totalUSD, 0);
  assert.deepEqual(v.devices, []);
});

test("the device id is made once and kept; a name you choose is kept too", () => {
  const first = thisDevice();
  assert.match(first.id, /^[a-f0-9]{16}$/);
  assert.ok(first.name.length > 0);
  assert.equal(thisDevice().id, first.id);
  assert.equal(thisDevice({ name: "Studio Mac" }).name, "Studio Mac");
  assert.equal(thisDevice().name, "Studio Mac");
});
