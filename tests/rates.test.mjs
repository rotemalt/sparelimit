import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spendRate, burnFromHistory, windowOutlook, FIVE_HOURS } from "../src/rates.mjs";
import { evaluate } from "../src/policy.mjs";
import { handleStatusline } from "../src/collector.mjs";
import { planOutlook, describeWindow } from "../src/plan.mjs";
import { snapshotPath } from "../src/state.mjs";
import { fixture, tempSparelimitHome } from "./helpers.mjs";

const T0 = Date.parse("2026-11-05T10:00:00Z");
const at = (min) => new Date(T0 + min * 60e3).toISOString();

test("spendRate: active hours ignore idle gaps; recent window and peak hour are separate", () => {
  const pts = [
    { ts: at(0), cost: 1, tokens: 1000 },
    { ts: at(10), cost: 1, tokens: 1000 },
    { ts: at(20), cost: 1, tokens: 1000 },
    { ts: at(600), cost: 3, tokens: 3000 }, // 9h40m idle gap is not counted
    { ts: at(610), cost: 3, tokens: 3000 }
  ];
  const r = spendRate(pts, 4);
  assert.equal(r.activeMinutes, 30); // 10+10+10 ; the idle gap is excluded
  assert.equal(r.costPerActiveHourUSD, 18); // $9 over 0.5 active hours
  assert.equal(r.recent.costUSD, 6); // last 30 min of the session: the two $3 calls
  assert.equal(r.recent.costPerHourUSD, 12);
  assert.equal(r.peakHourUSD, 6);
  assert.equal(r.costPerTurnUSD, 2.25);
});

test("spendRate: no timestamps means no rate rather than a made-up one", () => {
  assert.equal(spendRate([{ ts: undefined, cost: 1, tokens: 1 }]), null);
  assert.equal(spendRate([]), null);
});

test("burnFromHistory: percent-per-hour from recent samples; ignores samples before a quota reset", () => {
  const now = T0 + 30 * 60e3;
  const h = [
    { t: T0, cost: 1, fh: 10, sd: 30 },
    { t: T0 + 15 * 60e3, cost: 2, fh: 15, sd: 31 },
    { t: now, cost: 3, fh: 20, sd: 32 }
  ];
  const b = burnFromHistory(h, now);
  assert.equal(b.fiveHourPctPerHour, 20);
  assert.equal(b.costPerHourUSD, 4);
  // window reset (pct drops) -> only samples after the drop count
  const reset = [{ t: T0, fh: 90 }, { t: T0 + 10 * 60e3, fh: 2 }, { t: now, fh: 5 }];
  assert.equal(burnFromHistory(reset, now, { minSpanMs: 60e3 }).fiveHourPctPerHour, 9);
  assert.equal(burnFromHistory([{ t: now, fh: 1 }], now), null);
});

test("windowOutlook: says whether the quota lasts until the reset", () => {
  const now = T0;
  const resetsAt = (T0 + 3 * 3600e3) / 1000; // 3h left, 2h elapsed
  const fast = windowOutlook({ pct: 60, resetsAt }, { ratePctPerHour: 40, windowMs: FIVE_HOURS, now });
  assert.equal(fast.minutesToLimit, 60);
  assert.equal(fast.lastsUntilReset, false);
  const slow = windowOutlook({ pct: 20, resetsAt }, { ratePctPerHour: 5, windowMs: FIVE_HOURS, now });
  assert.equal(slow.lastsUntilReset, true);
  const avg = windowOutlook({ pct: 40, resetsAt }, { windowMs: FIVE_HOURS, now }); // 40% in 2h = 20%/h
  assert.equal(avg.basis, "window average");
  assert.equal(avg.ratePctPerHour, 20);
});

test("policy: the RECENT burn rate drives the 5-hour projection and is named in the message", () => {
  const now = T0;
  const r = evaluate({
    snapshot: { rateLimits: { fiveHour: { pct: 30, resetsAt: (T0 + 4 * 3600e3) / 1000 } }, burn: { fiveHourPctPerHour: 35, spanMin: 20 } },
    now
  });
  assert.equal(r.level, "warn");
  assert.match(r.findings[0].message, /35%\/h/);
  assert.match(r.findings[0].message, /recent/);
});

test("policy: weekly quota projection warns when the week's pace exhausts it before the reset", () => {
  const now = T0;
  // 3 days elapsed of 7, already 60% used -> 20%/day -> full in 2 days, 2 days before the reset
  const r = evaluate({ snapshot: { rateLimits: { sevenDay: { pct: 60, resetsAt: (T0 + 4 * 24 * 3600e3) / 1000 } } }, now });
  assert.equal(r.level, "warn");
  assert.equal(r.findings[0].rule, "quota.seven_day_projection");
});

test("policy: an hourly spend limit is off by default and enforceable when set", () => {
  const snapshot = { burn: { costPerHourUSD: 40, spanMin: 20 } };
  assert.equal(evaluate({ snapshot, now: T0 }).level, "allow");
  assert.equal(evaluate({ snapshot, policy: { budget: { hourlyWarnUSD: 20 } }, now: T0 }).level, "warn");
  assert.equal(evaluate({ snapshot, policy: { budget: { hourlyBlockUSD: 30 } }, now: T0 }).level, "block");
});

test("collector keeps a history and publishes burn rates; planOutlook reads it back", () => {
  tempSparelimitHome();
  const base = JSON.parse(fs.readFileSync(fixture("statusline.json"), "utf8"));
  const sid = base.session_id;
  const now0 = T0;
  const send = (min, cost, fh) => {
    const j = JSON.parse(JSON.stringify(base));
    j.cost.total_cost_usd = cost;
    j.rate_limits.five_hour = { used_percentage: fh, resets_at: (now0 + 4 * 3600e3) / 1000 };
    return handleStatusline(JSON.stringify(j), { account: null, now: now0 + min * 60e3 });
  };
  send(0, 1.0, 10);
  send(10, 2.0, 14);
  const line = send(20, 3.0, 18);
  const snap = JSON.parse(fs.readFileSync(snapshotPath(sid), "utf8"));
  assert.equal(snap.history.length, 3);
  assert.equal(snap.burn.fiveHourPctPerHour, 24);
  assert.equal(snap.burn.costPerHourUSD, 6);
  assert.match(line, /24%\/h/);
  const plan = planOutlook(sid, now0 + 21 * 60e3);
  assert.equal(plan.fiveHour.ratePctPerHour, 24);
  assert.match(describeWindow("5h", plan.fiveHour), /5h 18% used.*burning 24%\/h/);
});
