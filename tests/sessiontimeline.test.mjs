import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSessionTimeline, TIMELINE } from "../src/sessiontimeline.mjs";
import { auditSessionRows } from "../src/sessiontimeline-audit.mjs";
import { replaySession } from "../src/replay.mjs";
import { loadPricing } from "../src/pricing.mjs";
import { ROOT, tempSparelimitHome } from "./helpers.mjs";

const sparelimitHome = tempSparelimitHome();
const T0 = Date.parse("2026-11-05T08:00:00Z");
const MIN = 60e3;
// main-thread responses one minute apart with the given context percentages (or full entries)
const climb = (pcts, o = {}) => pcts.map((pct, i) => ({ t: T0 + i * MIN, cost: 1, side: false, pct, ctx: pct * 2000, errs: 0, coldUSD: 0, agent: null, ...(typeof o === "function" ? o(i) : o) }));
const result = (timeline, extra = {}) => ({ sessionId: "sess-1", project: "/Users/dana/.claude/projects/-Users-dana-Downloads-MyApp", start: new Date(T0).toISOString(), end: new Date(T0 + timeline.length * MIN).toISOString(), contextWindowTokens: 200000, durationMin: 12, spanDays: 0.1, findings: [], earlierReset: { savingUSD: 5, savingLowUSD: 4, savingHighUSD: 6 }, timeline, ...extra });
const kinds = (tl) => tl.moments.map((m) => m.kind);

test("thresholds and shrinks: the climb to the warning and the stop level, a drop, and the same again after it", () => {
  const tl = buildSessionTimeline({ result: result(climb([20, 40, 61, 70, 90, 96, 97, 9, 20, 62, 70])) });
  assert.deepEqual(kinds(tl), ["threshold", "threshold", "shrank", "threshold"]);
  assert.deepEqual(tl.moments.map((m) => [m.level, m.n]), [["warn", 3], ["stop", 6], [undefined, 8], ["warn", 10]]);
  assert.match(tl.moments[2].label, /shrank from 97% to 9%/);
  assert.deepEqual(tl.moments.map((m) => m.id), [1, 2, 3, 4], "numbered in time order");
  assert.equal(tl.moments[0].cumUSD, 3, "the spend so far at that response");
});

test("a shrink carries a before/after: cost per response over the 10 before and the next 30 after, cut at the next shrink; too little on either side gives none", () => {
  const pcts = [...Array(12).fill(80), ...Array(40).fill(10)];
  const tl = climb(pcts, (i) => ({ cost: i < 12 ? 2 : 0.5 }));
  const sh = buildSessionTimeline({ result: result(tl) }).moments.find((m) => m.kind === "shrank");
  assert.deepEqual(sh.compare, { before: { responses: 10, costPerResponse: 2, meanPct: 80 }, after: { responses: 30, costPerResponse: 0.5, meanPct: 10 }, changePct: -75, confidence: "measured before/after (the work may differ)" });
  const twice = climb([...Array(12).fill(80), ...Array(15).fill(40), ...Array(20).fill(10)]);
  const moments = buildSessionTimeline({ result: result(twice) }).moments.filter((m) => m.kind === "shrank");
  assert.equal(moments[0].compare.after.responses, 15, "the window ends where the next shrink begins");
  assert.equal(moments[1].compare.before.responses, 10);
  assert.equal(buildSessionTimeline({ result: result(climb([...Array(3).fill(80), ...Array(40).fill(10)])) }).moments.find((m) => m.kind === "shrank").compare, null, "fewer than 5 before");
  assert.equal(buildSessionTimeline({ result: result(climb([...Array(12).fill(80), ...Array(6).fill(10)])) }).moments.find((m) => m.kind === "shrank").compare, null, "fewer than 10 after");
});

test("no repeat while the context stays above the level; it re-arms after falling well below it", () => {
  const stays = buildSessionTimeline({ result: result(climb([61, 62, 63, 59, 64, 65])) });
  assert.equal(kinds(stays).length, 1, "59 is not far enough below 60 to start a new climb");
  const falls = buildSessionTimeline({ result: result(climb([61, 62, 50, 41, 62])) });
  assert.deepEqual(kinds(falls), ["threshold", "threshold"]);
});

test("cold returns, with the gap and the extra cost; pauses of an hour or more are marked as bands", () => {
  const tl = climb([30, 31, 32, 33], (i) => ({ t: T0 + [0, 1, 200, 201][i] * MIN, coldUSD: i === 2 ? 4.5 : 0 }));
  const out = buildSessionTimeline({ result: result(tl) });
  assert.deepEqual(kinds(out), ["cold"]);
  assert.match(out.moments[0].label, /Back after 3\.3 hours: .* about \$4\.5 more than a warm cache/);
  assert.deepEqual(out.gaps, [{ afterN: 2, minutes: 199 }]);
});

test("loops come from the replay's findings, once per rule and level", () => {
  const f = (rule, level, min) => ({ rule, level, t: new Date(T0 + min * MIN).toISOString(), message: `${rule} ${level}` });
  const out = buildSessionTimeline({ result: result(climb(Array(10).fill(20)), { findings: [f("loop.no_progress", "warn", 3), f("loop.no_progress", "warn", 5), f("loop.no_progress", "block", 7), f("context.window", "warn", 2)] }) });
  assert.deepEqual(out.moments.map((m) => [m.kind, m.level, m.n]), [["loop", "warn", 4], ["loop", "block", 8]]);
  assert.match(out.moments[1].label, /^Stop: loop\.no_progress block/);
});

test("error floods: 3 errored calls within 5 responses is one moment, and the next one needs a quiet stretch", () => {
  const withErrors = (errAt) => climb(Array(40).fill(20), (i) => ({ errs: errAt.includes(i) ? 1 : 0 }));
  const out = buildSessionTimeline({ result: result(withErrors([5, 6, 7, 8, 9, 10, 11, 30, 31, 32])) });
  assert.deepEqual(out.moments.map((m) => [m.kind, m.n, m.errors]), [["errors", 6, 3], ["errors", 31, 3]], "the first patch is one moment, not five; a later patch is another");
  assert.equal(buildSessionTimeline({ result: result(withErrors([5, 9, 20])) }).moments.length, 0, "scattered failures are not a flood");
  assert.equal(TIMELINE.errorFlood, 3);
});

test("swarm: the moment the number of subagents running at once reaches 4, by subagent id and time", () => {
  const main = climb(Array(10).fill(20));
  const side = (agent, from, to) => [from, to].map((m) => ({ t: T0 + m * MIN + 5000, cost: 0.5, side: true, pct: null, ctx: 50000, errs: 0, coldUSD: 0, agent }));
  const four = [...main, ...side("a1", 1, 6), ...side("a2", 2, 6), ...side("a3", 2, 7), ...side("a4", 3, 8)];
  const out = buildSessionTimeline({ result: result(four) });
  assert.deepEqual(out.moments.map((m) => [m.kind, m.agents, m.n]), [["swarm", 4, 4]]);
  const three = [...main, ...side("a1", 1, 6), ...side("a2", 2, 6), ...side("a3", 2, 7)];
  assert.equal(buildSessionTimeline({ result: result(three) }).moments.length, 0);
  const sequential = [...main, ...side("a1", 1, 2), ...side("a2", 3, 4), ...side("a3", 5, 6), ...side("a4", 7, 8)];
  assert.equal(buildSessionTimeline({ result: result(sequential) }).moments.length, 0, "one after another is not a swarm here");
  assert.equal(out.points.length, 10, "subagent responses are not points on the main context line");
  assert.equal(out.totalUSD, 10 + 4 * 1, "but their cost is in the total");
});

test("what Sparelimit said in this session is on the timeline; other sessions and other kinds of rows are not; repeats within 30 minutes are one", () => {
  const row = (rule, min, sessionId = "sess-1", kind = "finding") => ({ t: new Date(T0 + min * MIN).toISOString(), kind, rule, message: `${rule} said`, sessionId });
  const rows = [row("quota.projection", 2), row("quota.projection", 20), row("quota.projection", 60), row("context.reset", 4, "sess-1", "coach"), row("quota.projection", 3, "other"), { t: new Date(T0).toISOString(), kind: "probe", sessionId: "sess-1" }];
  assert.deepEqual(auditSessionRows(rows, "sess-1").map((a) => [a.rule, a.count]), [["quota.projection", 2], ["context.reset", 1], ["quota.projection", 1]]);
  const out = buildSessionTimeline({ result: result(climb(Array(70).fill(20))), auditRows: rows });
  assert.deepEqual(out.moments.map((m) => [m.kind, m.n, m.count]), [["sparelimit", 3, 2], ["sparelimit", 5, 1], ["sparelimit", 61, 1]]);
  assert.match(out.moments[0].label, /^Sparelimit said: quota\.projection said/);
});

test("summary: the share of responses and spend at the warning level or above (derived), the estimate passed through, only the folder name of the project", () => {
  const tl = climb([20, 30, 65, 70, 80, 90], (i) => ({ cost: i < 2 ? 1 : 3 })); // 4 of 6 responses at 60%+, $12 of $14
  const out = buildSessionTimeline({ result: result(tl) });
  assert.deepEqual(out.summary.aboveWarn, { responses: 4, shareOfResponses: 66.7, usd: 12, shareOfSpend: 85.7, confidence: "derived" });
  assert.deepEqual(out.summary.earlierReset, { savingUSD: 5, lowUSD: 4, highUSD: 6, confidence: "estimated" });
  assert.equal(out.project, "Downloads-MyApp");
  assert.doesNotMatch(JSON.stringify(out), /\/Users\//, "no local path in the output");
  assert.equal(out.thresholds.warnPct, 60);
  assert.equal(buildSessionTimeline({ result: result(climb([20]), { earlierReset: null }) }).summary.earlierReset, null);
});

test("the replay's timeline carries what the session timeline needs: context tokens, errored calls and the subagent", () => {
  const pricing = loadPricing();
  const mk = (min, extra = {}) => ({ id: `e${min}`, ts: new Date(T0 + min * MIN).toISOString(), model: "claude-sonnet-5-5", isSidechain: false, usage: { input: 10, cacheRead: 40000, cacheWrite5m: 0, cacheWrite1h: 0, output: 100 }, context: 40010, tools: [], calls: [], confidence: "derived", ...extra });
  const events = [mk(0, { calls: [{ name: "Bash", sig: "a", res: "!abc" }, { name: "Bash", sig: "b", res: "ok" }, { name: "Read", sig: "c" }] }), mk(1, { isSidechain: true, agentId: "agent-x" })];
  const r = replaySession({ agent: "claude-code", sessionId: "s", events, userTurns: [], commandResults: [], fileTouches: [], raw: {} }, { pricing, withEvents: true });
  assert.deepEqual(r.timeline.map((e) => [e.ctx, e.errs, e.agent]), [[40010, 1, null], [40010, 0, "agent-x"]]);
});

// ---- command and endpoints on a seeded machine
const sid = "11111111-2222-3333-4444-555555555555";
const seed = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-"));
  const dir = path.join(home, ".claude", "projects", "-Users-tester-Downloads-Demo");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  for (let i = 0; i < 40; i++) {
    const ctx = 20000 + i * 4000; // climbs to 176k of a 200k window
    lines.push(JSON.stringify({ type: "assistant", sessionId: sid, uuid: `a${i}`, timestamp: new Date(Date.now() - (40 - i) * MIN).toISOString(), message: { id: `m${i}`, model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: ctx - 10, cache_creation_input_tokens: 0, output_tokens: 100 }, content: [] } }));
  }
  fs.writeFileSync(path.join(dir, `${sid}.jsonl`), lines.join("\n") + "\n");
  return home;
};
const sparelimit = (home, args) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { encoding: "utf8", env: { ...process.env, HOME: home, SPARELIMIT_HOME: sparelimitHome } });

test("sparelimit timeline: text with the sparkline and moments, --json, a unique id prefix, and clear errors", () => {
  const home = seed();
  const text = sparelimit(home, ["timeline"]);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /SPARELIMIT SESSION TIMELINE  11111111…  Downloads-Demo/);
  assert.match(text.stdout, /context  [ ▁▂▃▄▅▆▇█]+/);
  assert.match(text.stdout, /happened at 60% of the window or more \[derived\]/);
  assert.match(text.stdout, /threshold The context reached 6\d% of the window/);
  assert.match(text.stdout, /sparelimit method/);
  const j = JSON.parse(sparelimit(home, ["timeline", "11111111", "--json"]).stdout);
  assert.equal(j.responses, 40);
  assert.equal(j.moments.filter((m) => m.kind === "threshold").length, 1, "reached 88% but never 95%");
  assert.equal(sparelimit(home, ["timeline", "99999999"]).status, 1);
  assert.match(sparelimit(home, ["timeline", "99999999"]).stderr, /No session matching/);
  assert.equal(sparelimit(fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-")), ["timeline"]).status, 1);
});

test("dashboard: /api/sessions lists sessions without file paths; /api/timeline takes an id only: bad ids are 400, unknown ids 404, a known id gets its timeline", async () => {
  const { startServer } = await import("../sparelimit.mjs");
  const home = seed();
  process.env.HOME = home;
  const server = startServer(null, null, 0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const log = console.log;
  console.log = () => {};
  try {
    const list = await (await fetch(`${base}/api/sessions`)).json();
    assert.deepEqual(list.map((s) => [s.id, s.project]), [[sid, "Downloads-Demo"]]);
    assert.doesNotMatch(JSON.stringify(list), /filePath|\/Users\/|\.jsonl/);
    for (const bad of ["../../etc/passwd", "a/b", "short", "x".repeat(81), "%2e%2e%2f%2e%2e%2fetc%2fpasswd", ""]) assert.equal((await fetch(`${base}/api/timeline?id=${bad}`)).status, 400, bad);
    assert.equal((await fetch(`${base}/api/timeline?id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`)).status, 404);
    const ok = await fetch(`${base}/api/timeline?id=${sid}`);
    assert.equal(ok.status, 200);
    const tl = await ok.json();
    assert.equal(tl.sessionId, sid);
    assert.equal(tl.points.length, 40);
    assert.doesNotMatch(JSON.stringify(tl), /\/Users\//);
  } finally {
    console.log = log;
    server.close();
  }
});
