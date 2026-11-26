import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { hourlyBuckets, dailyBuckets, spendRate, overview, interventionFeed } from "../src/dashdata.mjs";
import { ROOT, tempSparelimitHome } from "./helpers.mjs";

const sparelimitHome = tempSparelimitHome();
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime(); // local time, as the dashboard uses
const NOW = local(2026, 11, 5, 14, 30);
const ev = (t, cost) => ({ t, cost });

test("hourly buckets: 24 clock hours ending with the current, partly elapsed one; older and future events are left out", () => {
  const events = [ev(local(2026, 11, 5, 14, 10), 1), ev(local(2026, 11, 5, 13, 59), 2), ev(local(2026, 11, 4, 15, 0), 4), ev(local(2026, 11, 4, 14, 59), 99), ev(local(2026, 11, 5, 15, 5), 99)];
  const b = hourlyBuckets(events, NOW);
  assert.equal(b.length, 24);
  assert.equal(b[23].start, local(2026, 11, 5, 14, 0));
  assert.equal(b[23].usd, 1);
  assert.equal(b[23].partial, true);
  assert.equal(b[22].usd, 2);
  assert.equal(b[22].partial, false);
  assert.equal(b[0].start, local(2026, 11, 4, 15, 0));
  assert.equal(b[0].usd, 4, "the oldest hour kept");
  assert.equal(b.reduce((n, x) => n + x.usd, 0), 7, "the hour before it and the future are out");
});

test("daily buckets: seven local days ending with TODAY (a regression: today's spend was folded into yesterday)", () => {
  const events = [ev(local(2026, 11, 5, 9), 3), ev(local(2026, 11, 4, 23, 59), 2), ev(local(2026, 10, 30, 0, 0), 1), ev(local(2026, 10, 29, 23, 59), 99)];
  const b = dailyBuckets(events, NOW);
  assert.equal(b.length, 7);
  assert.equal(b[0].start, local(2026, 10, 30), "six days ago");
  assert.equal(b[6].start, local(2026, 11, 5), "today is the last bar");
  assert.deepEqual(b.map((x) => x.usd), [1, 0, 0, 0, 0, 2, 3]);
  assert.deepEqual(b.map((x) => x.partial), [false, false, false, false, false, false, true], "only today is partial");
  assert.ok(b.every((x) => new Date(x.start).getHours() === 0), "each bucket starts at local midnight");
});

test("daily buckets keep local midnights across a month and year end", () => {
  const b = dailyBuckets([], local(2027, 1, 2, 8), 7);
  assert.deepEqual(b.map((x) => new Date(x.start).getDate()), [27, 28, 29, 30, 31, 1, 2]);
});

test("spend rate: the last 30 minutes scaled to an hour, beside the busiest hour of the last 24", () => {
  const events = [ev(NOW - 10 * 60e3, 1), ev(NOW - 40 * 60e3, 5), ev(local(2026, 11, 5, 9, 30), 3)];
  const r = spendRate(events, NOW);
  assert.equal(r.perHourUSD, 2);
  assert.equal(r.windowMin, 30);
  assert.equal(r.peakHourUSD, 5); // 13:50 is in the 13:00 hour ($5), 14:20 in the 14:00 hour ($1), 09:30 in the 09:00 hour ($3)
});

test("overview: gauges from the plan estimate; not calibrated when there are no limits", () => {
  const est = { limits: { fiveHourUSD: 29.18, weeklyUSD: 251.86 }, calibratedOn: 2, fiveHour: { spentUSD: 14.8, pct: 50.73, resetsAt: 1793923200, resetsInMin: 161, ratePctPerHour: 21.8, basis: "recent", minutesToLimit: 135, lastsUntilReset: false }, weekly: null };
  const o = overview({ events: [], estimate: est, now: NOW });
  assert.equal(o.calibrated, true);
  assert.deepEqual([o.plan.fiveHour.pct, o.plan.fiveHour.limitUSD, o.plan.fiveHour.resetsAt, o.plan.fiveHour.lastsUntilReset], [50.7, 29.18, 1793923200000, false]);
  assert.equal(o.plan.weekly, null);
  assert.equal(o.plan.confidence, "estimated");
  assert.equal(o.history.confidence, "derived");
  assert.equal(o.history.hourly.length, 24);
  assert.equal(o.history.daily.length, 7);
  const none = overview({ events: [], estimate: { limits: {}, calibratedOn: 0, fiveHour: null, weekly: null }, now: NOW });
  assert.equal(none.calibrated, false);
  assert.equal(overview({ events: [], estimate: null, now: NOW }).calibrated, false);
});

// ---- the feed
const iso = (ms) => new Date(ms).toISOString();
const row = (rule, ms, o = {}) => ({ t: iso(ms), kind: rule.startsWith("quota") || rule === "context.window" ? "finding" : "coach", rule, level: "warn", message: `${rule} said`, sessionId: "s1", ...o });
const MIN = 60e3;

test("feed: repeats of the same rule in the same session within 30 minutes are one item with a count; newest first; kinds are named", () => {
  const rows = [row("quota.projection", NOW - 100 * MIN), row("quota.projection", NOW - 80 * MIN), row("quota.projection", NOW - 55 * MIN), row("quota.projection", NOW - 10 * MIN), row("quota.projection", NOW - 10 * MIN, { sessionId: "s2" }), row("context.reset", NOW - 30 * MIN), row("loop.identical_calls", NOW - 20 * MIN, { kind: "finding", level: "block" }), { t: iso(NOW - 5 * MIN), kind: "probe" }];
  const f = interventionFeed(rows, [], NOW);
  assert.deepEqual(f.map((i) => [i.rule, i.count, i.kind]), [["quota.projection", 1, "warning"], ["quota.projection", 1, "warning"], ["loop.identical_calls", 1, "stop"], ["context.reset", 1, "nudge"], ["quota.projection", 3, "warning"]]);
  assert.equal(f[4].message, "quota.projection said");
  assert.ok(f.every((i, n) => n === 0 || f[n - 1].t >= i.t), "newest first");
});

test("feed: the ledger's verdict is attached to the same alert; other alerts and old ones are not", () => {
  const entries = [
    { family: "quota", rules: ["quota.projection", "quota.seven_day"], at: iso(NOW - 50 * MIN), status: "ignored", note: "spending did not slow down" },
    { family: "reset", rules: ["context.reset"], at: iso(NOW - 30 * MIN), status: "counted", savingUSD: 4.5, how: "context shrank" },
    { family: "cold", rules: ["cache.cold"], at: iso(NOW - 3 * 86400e3), status: "ignored" }
  ];
  const rows = [row("quota.seven_day", NOW - 20 * MIN), row("context.reset", NOW - 30 * MIN), row("loop.identical_calls", NOW - 25 * MIN), row("quota.five_hour", NOW - 90 * MIN)];
  const f = Object.fromEntries(interventionFeed(rows, entries, NOW).map((i) => [i.rule, i]));
  assert.equal(f["quota.seven_day"].outcome.status, "ignored", "a later alert in the same cluster (within an hour of its start)");
  assert.equal(f["quota.five_hour"].outcome, null, "this rule was not in that cluster");
  assert.deepEqual([f["context.reset"].outcome.status, f["context.reset"].outcome.savingUSD], ["counted", 4.5]);
  assert.equal(f["loop.identical_calls"].outcome, null, "loops are not in the ledger");
});

test("feed: only the last 7 days, and an empty log gives an empty feed", () => {
  assert.equal(interventionFeed([row("quota.projection", NOW - 8 * 86400e3), row("quota.projection", NOW - 6 * 86400e3)], [], NOW).length, 1);
  assert.deepEqual(interventionFeed([], [], NOW), []);
});

// ---- endpoints on a seeded machine
const seed = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-"));
  fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
  const t = Date.now() - 10 * 60e3;
  fs.writeFileSync(path.join(home, ".claude", "projects", "p", "s.jsonl"), [
    JSON.stringify({ type: "assistant", sessionId: "s1", uuid: "a", timestamp: new Date(t).toISOString(), message: { id: "m1", model: "claude-sonnet-5-5", usage: { input_tokens: 100, cache_read_input_tokens: 200000, cache_creation_input_tokens: 0, output_tokens: 2000 }, content: [] } })
  ].join("\n") + "\n");
  return home;
};

test("dashboard: /api/overview reads the logs, and says not calibrated until there are calibration points", async () => {
  const { startServer } = await import("../sparelimit.mjs");
  const get = async (home, p) => {
    process.env.HOME = home;
    const server = startServer(null, null, 0);
    await new Promise((r) => server.once("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`);
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
    }
  };
  const log = console.log;
  console.log = () => {};
  try {
    const home = seed();
    const before = await get(home, "/api/overview");
    assert.equal(before.status, 200);
    assert.equal(before.body.calibrated, false);
    assert.equal(before.body.plan.fiveHour, null);
    assert.equal(before.body.history.hourly.length, 24);
    assert.ok(before.body.history.hourly.reduce((n, b) => n + b.usd, 0) > 0, "the seeded response is in the history");
    fs.writeFileSync(path.join(sparelimitHome, "calibration.json"), JSON.stringify({ points: [{ at: new Date().toISOString(), fivePct: 50, spendFive: 0.1, weeklyPct: 40, spendWeek: 0.2, weeklyResetMs: Date.now() + 3 * 86400e3 }] }));
    const after = await get(home, "/api/overview");
    assert.equal(after.body.calibrated, true);
    assert.equal(after.body.plan.confidence, "estimated");
    assert.ok(after.body.plan.fiveHour.pct > 0 && after.body.plan.fiveHour.limitUSD > 0);
    assert.ok(after.body.plan.weekly.resetsAt > Date.now());
    // the feed: an audit row for the seeded session is joined with the ledger's verdict
    fs.writeFileSync(path.join(sparelimitHome, "audit.jsonl"), JSON.stringify({ t: new Date(Date.now() - 3 * 3600e3).toISOString(), kind: "finding", rule: "quota.projection", level: "warn", message: "burning fast", sessionId: "s1" }) + "\n");
    const feed = await get(home, "/api/feed");
    assert.equal(feed.status, 200);
    assert.equal(feed.body.ledgerReady, true);
    assert.equal(feed.body.items.length, 1);
    assert.equal(feed.body.items[0].message, "burning fast");
    assert.ok(feed.body.items[0].outcome, "the ledger judged it");
    assert.equal(feed.body.ledger.interventions, 1);
  } finally {
    console.log = log;
  }
});

test("dashboard page: the old 'Waste Prevented' wording is gone, and the new cards carry the three labels", () => {
  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  assert.doesNotMatch(html, /Waste Prevented/);
  assert.doesNotMatch(js, /saved by cutting thread/);
  assert.match(html, /Possible Saving, This Session/);
  assert.match(html, /5-hour limit<\/h2><span class="tag-badge warn">ESTIMATED/);
  assert.match(html, /Last 24 hours<\/h2><span class="tag-badge good">DERIVED/);
  assert.match(js, /Estimated, not counted/);
  const added = js.slice(js.indexOf("// ---- \"What to change\" card"));
  assert.ok(added.length > 2000);
  assert.doesNotMatch(added, /innerHTML/, "the coach, digest and overview cards are built with textContent and SVG only");
});

test("pre-flight (X10): one message as a share of the five-hour limit, from the dollar model; null without a calibrated limit or a cost", async () => {
  const { preflightPct, overview } = await import("../src/dashdata.mjs");
  assert.equal(preflightPct(0.052, 13), 0.4);
  assert.equal(preflightPct(1.3, 13), 10);
  assert.equal(preflightPct(0.05, null), null);
  assert.equal(preflightPct(0, 13), null);
  assert.equal(preflightPct(0.05, 0), null);
  const o = overview({ events: [], estimate: { limits: { fiveHourUSD: 13 }, calibratedOn: 3 }, now: Date.now() });
  assert.equal(o.plan.fiveHourLimitUSD, 13);
  assert.equal(overview({ events: [], estimate: null, now: Date.now() }).plan.fiveHourLimitUSD, null);
});
