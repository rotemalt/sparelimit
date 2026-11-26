import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, fixture, tempSparelimitHome } from "./helpers.mjs";
import { COUNT_ADDRESSES } from "../src/countaddresses.mjs";
import { LATER_DAYS, OFFER_TEXT, afterReport, countFile, due, isInteractive, parseAnswer, readCount, sayYes, saveCount, send, shouldOffer } from "../src/count.mjs";
import { ping } from "../scripts/count-ping.mjs";
import { scan } from "../src/safeshare.mjs";
import { VERSION } from "../src/constants.mjs";

tempSparelimitHome();
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const DAY = 86400e3;
const T0 = Date.parse("2026-12-01T10:00:00Z");
const saving = (ms, usd = 3) => ({ at: new Date(ms).toISOString(), family: "quota", status: "counted", savingUSD: usd });
const clear = () => fs.rmSync(countFile(), { force: true });

/** Runs the offer with a scripted person at a fake clock, and records every request instead of making it. */
async function visit({ typed = null, now = T0, entries = [saving(T0 - 3600e3)], ran = false, interactive = true, mayAsk = true } = {}) {
  const asked = [];
  const requested = [];
  const printed = [];
  await afterReport({ entries, ran, interactive, mayAsk, now, ask: async () => (asked.push(1), typed ?? ""), request: (k) => requested.push(k), print: (s) => printed.push(s) });
  return { asked: asked.length, requested, printed: printed.join("\n"), state: readCount() };
}

test("the two addresses are pinned: this version's release, these two files, and nothing else", () => {
  assert.deepEqual(COUNT_ADDRESSES, {
    "opted-in": "https://github.com/rotemalt/sparelimit/releases/download/v1.1.0/count-opted-in",
    saving: "https://github.com/rotemalt/sparelimit/releases/download/v1.1.0/count-saving"
  });
  for (const u of Object.values(COUNT_ADDRESSES)) assert.ok(u.includes(`/v${VERSION}/`), "a new version needs new addresses");
  assert.equal(JSON.parse(read("package.json")).version, VERSION);
  for (const f of ["src/count.mjs", "src/cli/count.mjs", "scripts/count-ping.mjs"]) assert.doesNotMatch(read(f), /https?:\/\//, `${f} writes no address of its own`);
});

test("the request is one plain download of one of the two files: no body, no custom header, no query, nothing else", async () => {
  const calls = [];
  const fake = async (url, init) => (calls.push([url, init]), { ok: true, arrayBuffer: async () => new ArrayBuffer(1) });
  assert.equal(await ping("opted-in", fake), true);
  assert.equal(await ping("saving", fake), true);
  assert.deepEqual(calls.map((c) => c[0]), Object.values(COUNT_ADDRESSES));
  for (const [, init] of calls) assert.deepEqual(Object.keys(init), ["signal"], "only a timeout: no method, body or headers");
  for (const bad of ["https://example.com/x", "__proto__", "toString", "", undefined]) assert.equal(await ping(bad, fake), false, String(bad));
  assert.equal(calls.length, 2, "any other word requests nothing");
});

test("a failed request is dropped: no error, no retry, and it times out", async () => {
  let n = 0;
  assert.equal(await ping("saving", async () => { n++; throw new Error("offline"); }), false);
  assert.equal(await ping("saving", async () => { n++; return { ok: false, arrayBuffer: async () => new ArrayBuffer(0) }; }), false);
  assert.equal(n, 2, "once each");
});

test("sending starts a detached process and returns at once, and a process that cannot start is dropped", () => {
  const seen = [];
  send("saving", (cmd, args, opts) => (seen.push({ cmd, args, opts }), { on() {}, unref: () => seen.push("unref") }));
  assert.equal(seen[0].cmd, process.execPath);
  assert.equal(path.basename(seen[0].args[0]), "count-ping.mjs");
  assert.ok(fs.existsSync(seen[0].args[0]));
  assert.deepEqual([seen[0].args[1], seen[0].opts.detached, seen[0].opts.stdio, seen[1]], ["saving", true, "ignore", "unref"]);
  assert.doesNotThrow(() => send("saving", () => { throw new Error("no"); }));
});

test("off by default: with no answer nothing is requested, whatever has been counted", () => {
  clear();
  assert.equal(readCount().answer, null);
  assert.deepEqual(due(readCount(), { now: T0, entries: [saving(T0)] }).kinds, []);
  fs.mkdirSync(path.dirname(countFile()), { recursive: true });
  fs.writeFileSync(countFile(), "{{{ not json");
  assert.equal(readCount().answer, null, "a damaged file is no answer");
  fs.writeFileSync(countFile(), JSON.stringify({ answer: "YES please" }));
  assert.equal(readCount().answer, null, "only an exact answer counts");
});

test("only a clear yes is a yes; no is never; silence and anything else is not now", () => {
  for (const y of ["yes", " Y ", "YES"]) assert.equal(parseAnswer(y), "yes", y);
  for (const n of ["never", "no", "N"]) assert.equal(parseAnswer(n), "never", n);
  for (const l of ["", "   ", "not now", "later", "yess", "ok", "sure", undefined, null]) assert.equal(parseAnswer(l), "later", String(l));
});

test("not a terminal, or CI: nothing is asked, nothing is requested, nothing is written", async () => {
  const tty = { isTTY: true };
  assert.equal(isInteractive({ stdin: tty, stdout: tty, env: {} }), true);
  for (const o of [{ stdin: {}, stdout: tty, env: {} }, { stdin: tty, stdout: {}, env: {} }, { stdin: tty, stdout: tty, env: { CI: "true" } }, { stdin: tty, stdout: tty, env: { GITHUB_ACTIONS: "true" } }]) assert.equal(isInteractive(o), false);
  clear();
  let r = await visit({ interactive: false, typed: "yes" });
  assert.deepEqual([r.asked, r.requested, fs.existsSync(countFile())], [0, [], false]);
  saveCount(sayYes(readCount(), { now: T0 }));
  r = await visit({ interactive: false, entries: [saving(T0 + 1000)] });
  assert.deepEqual(r.requested, [], "even after a yes");
});

test("without a finished replay or weekly summary, only a counted saving is a moment to ask; --json and --share never ask", async () => {
  clear();
  for (const entries of [[], [{ at: new Date(T0).toISOString(), family: "quota", status: "ignored" }], [saving(T0, -2)]]) {
    const r = await visit({ entries, typed: "yes" });
    assert.deepEqual([r.asked, r.requested], [0, []]);
  }
  for (const ran of [false, true]) {
    const r = await visit({ mayAsk: false, ran, typed: "yes" });
    assert.deepEqual([r.asked, r.requested], [0, []]);
  }
});

test("a finished replay or weekly summary is enough to be asked, with no saving at all; yes then requests the opt-in file and no saving file", async () => {
  clear();
  let r = await visit({ ran: true, entries: [], typed: "yes" });
  assert.deepEqual([r.asked, r.requested, r.state.answer], [1, ["opted-in"], "yes"]);
  assert.deepEqual((await visit({ ran: true, entries: [], now: T0 + DAY })).requested, [], "no saving, no saving request");
  assert.deepEqual((await visit({ ran: true, entries: [saving(T0 + DAY)], now: T0 + DAY + 1000 })).requested, ["saving"], "the saving count is as before");
  clear();
  r = await visit({ ran: true, entries: [], typed: "never" });
  assert.deepEqual([r.asked, r.requested], [1, []]);
  assert.equal((await visit({ ran: true, entries: [saving(T0)], now: T0 + 90 * DAY, typed: "yes" })).asked, 0);
  clear();
  await visit({ ran: true, entries: [], typed: "" });
  assert.equal((await visit({ ran: true, entries: [], now: T0 + 29 * DAY })).asked, 0);
  assert.equal((await visit({ ran: true, entries: [], now: T0 + 30 * DAY })).asked, 1);
  assert.equal((await visit({ ran: true, entries: [], now: T0 + 200 * DAY })).asked, 0);
});

test("the offer does not claim a saving was counted, since it can come before any", () => {
  assert.doesNotMatch(OFFER_TEXT, /just counted a saving/i);
});

test("yes: asked once, the opt-in file once ever, and old savings are not reported", async () => {
  clear();
  let r = await visit({ typed: "yes" });
  assert.equal(r.asked, 1);
  assert.ok(r.printed.includes(OFFER_TEXT));
  assert.deepEqual(r.requested, ["opted-in"]);
  r = await visit({ typed: "yes", now: T0 + 2 * DAY });
  assert.deepEqual([r.asked, r.requested], [0, []]);
  saveCount({ ...readCount(), answer: "off" });
  saveCount(sayYes(readCount(), { now: T0 + 3 * DAY }));
  r = await visit({ now: T0 + 3 * DAY });
  assert.deepEqual(r.requested, [], "off and on again does not request the opt-in file again");
});

test("after a yes: at most one saving request a day, only when a new saving was counted", async () => {
  clear();
  await visit({ typed: "yes" });
  const first = saving(T0 - 3600e3);
  const a = saving(T0 + 3600e3);
  const b = saving(T0 + 7200e3);
  assert.deepEqual((await visit({ now: T0 + 5000e3, entries: [first] })).requested, [], "no new saving");
  assert.deepEqual((await visit({ now: T0 + 5000e3, entries: [first, a] })).requested, ["saving"]);
  assert.deepEqual((await visit({ now: T0 + 9000e3, entries: [first, a, b] })).requested, [], "second saving the same day");
  assert.deepEqual((await visit({ now: T0 + DAY, entries: [first, a, b] })).requested, [], "yesterday's savings are not sent tomorrow");
  assert.deepEqual((await visit({ now: T0 + DAY, entries: [first, a, b, saving(T0 + DAY - 1000)] })).requested, ["saving"]);
  assert.deepEqual((await visit({ now: T0 + 2 * DAY, entries: [saving(T0 - 10 * DAY)] })).requested, [], "an old saving from before the yes is not new");
});

test("not now: asked again once, after 30 days and no earlier, then never again", async () => {
  clear();
  let r = await visit({ typed: "not now" });
  assert.deepEqual([r.asked, r.requested, r.state.answer], [1, [], "later"]);
  assert.equal(LATER_DAYS, 30);
  r = await visit({ typed: "yes", now: T0 + 30 * DAY - 1000 });
  assert.deepEqual([r.asked, r.requested], [0, []], "a second before 30 days");
  r = await visit({ typed: "", now: T0 + 30 * DAY });
  assert.deepEqual([r.asked, r.requested, r.state.asked], [1, [], 2]);
  for (const d of [61, 400]) assert.equal((await visit({ typed: "yes", now: T0 + d * DAY })).asked, 0, `day ${d}`);
});

test("never, no and off are not asked again and request nothing", async () => {
  for (const typed of ["never", "no"]) {
    clear();
    await visit({ typed });
    const r = await visit({ typed: "yes", now: T0 + 400 * DAY, entries: [saving(T0 + 400 * DAY)] });
    assert.deepEqual([r.asked, r.requested, r.state.answer], [0, [], "never"], typed);
  }
  assert.equal(shouldOffer({ ...readCount(), answer: "off" }, { now: T0 + 900 * DAY, moment: true }), false);
});

test("closing the terminal at the question counts as asked once, with nothing requested", async () => {
  clear();
  const requested = [];
  await afterReport({ entries: [saving(T0)], interactive: true, now: T0, ask: async () => { throw new Error("closed"); }, request: (k) => requested.push(k), print: () => {} });
  assert.deepEqual([requested, readCount().answer, readCount().asked], [[], "later", 1]);
});

test("nothing in the count can break a command", async () => {
  clear();
  await assert.doesNotReject(afterReport({ entries: null, interactive: true, ask: async () => "yes", request: () => { throw new Error("x"); }, print: () => { throw new Error("y"); } }));
});

// ---- the commands
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-count-"));
fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
fs.copyFileSync(fixture("claude-code-session.jsonl"), path.join(home, ".claude", "projects", "p", "s.jsonl"));
const vh = path.join(home, ".sparelimit");
// any request that did start would go through this stub, which writes down the address instead of connecting
const log = path.join(home, "requests.log");
const stub = path.join(home, "stub.mjs");
fs.writeFileSync(stub, `import fs from "node:fs"; globalThis.fetch = async (u) => { fs.appendFileSync(${JSON.stringify(log)}, String(u) + "\\n"); return { ok: true, arrayBuffer: async () => new ArrayBuffer(1) }; };`);
const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { encoding: "utf8", timeout: 60000, env: { ...process.env, HOME: home, SPARELIMIT_HOME: vh, SPARELIMIT_NO_CACHE: "1", SPARELIMIT_NO_REFRESH: "1", NODE_OPTIONS: `--import ${stub}` } });

test("count status and count show request nothing; show prints exactly the two addresses", () => {
  const s = run("count");
  assert.equal(s.status, 0, s.stderr);
  assert.match(s.stdout, /optional count is OFF/);
  const w = run("count", "show");
  assert.deepEqual(w.stdout.match(/https?:\/\/\S+/g), Object.values(COUNT_ADDRESSES));
  assert.match(w.stdout, /This command requests nothing/);
  assert.equal(fs.existsSync(path.join(vh, "count.json")), false);
  assert.equal(fs.existsSync(log), false);
});

test("count on from a script records the yes and requests nothing there; count off turns it off; piped week and ledger stay silent", () => {
  assert.match(run("count", "on").stdout, /Nothing was requested now/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(vh, "count.json"), "utf8")).answer, "yes");
  for (const args of [["replay", "--all"], ["replay", "--all", "--json"], ["week"], ["week", "--json"], ["ledger"], ["ledger", "--share"]]) {
    const r = run(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /Count it\?|may Sparelimit be counted/);
  }
  assert.equal(fs.existsSync(log), false, "no request from a pipe");
  assert.match(run("count", "off").stdout, /Counting is off/);
  assert.match(run("count").stdout, /OFF/);
  assert.equal(run("count", "maybe").status, 1);
});


// ---- the words
const section = () => read("README.md").split("## The optional count")[1].split("\n## ")[0];

test("the offer, the README section and the privacy page say the same things, and none claims that no data exists at all", () => {
  const privacy = read("site", "privacy.html").split("<h2>The optional count</h2>")[1].split("<h2>")[0].replace(/<[^>]+>/g, " ");
  const flat = (s) => s.replace(/\s+/g, " ");
  for (const t of [OFFER_TEXT, section(), privacy].map(flat)) {
    assert.match(t, /Nothing about you or your work is sent to the author/);
    assert.match(t, /no identifier exists/);
    assert.match(t, /GitHub sees your address, as (it does )?for any download/);
    assert.match(t, /public and approximate/);
    assert.match(t, /works the same either way/);
    assert.match(t, /[Oo]ff unless you say yes/);
    assert.doesNotMatch(t, /no data at all|nothing is collected|collects nothing|anonymous|exact count|number of users|number of people (use|using)|vera|shelf|platform/i);
  }
  assert.match(section(), /not a number of people/);
});

test("the README names the release file first, and safe-to-share finds nothing in the new section or the privacy page", () => {
  const readme = read("README.md");
  assert.ok(readme.indexOf(`npm install -g https://github.com/rotemalt/sparelimit/releases/download/v${VERSION}/sparelimit-${VERSION}.tgz`) < readme.indexOf("git clone"), "the release file comes before the clone");
  const names = [os.userInfo().username, os.hostname().split(".")[0]];
  assert.deepEqual(scan(section(), { names }), []);
  // the privacy page names the contact address and the folder it writes, on purpose; nothing else may be found
  assert.deepEqual(scan(read("site", "privacy.html"), { names }).filter((f) => !["email address", "home path"].includes(f.kind)), []);
});

test("the release package holds what the commands need", () => {
  const files = JSON.parse(read("package.json")).files;
  for (const f of ["scripts/count-ping.mjs", "src", "data", "sparelimit.mjs"]) assert.ok(files.includes(f), f);
});
