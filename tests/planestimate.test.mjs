import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fiveHourWindows, weeklyWindow, parseResetSpec, fitLimits, addCalibrationPoint, estimatePlanUsage, calibrationPath, spendIn } from "../src/planestimate.mjs";
import { tempSparelimitHome } from "./helpers.mjs";

const H = 3600e3;
const utc = (d, h, m = 0) => Date.UTC(2026, 10, d, h, m);

test("5-hour windows open at the first event after the previous window ended, rounded down to the hour", () => {
  const w = fiveHourWindows([utc(5, 11, 5), utc(5, 11, 40), utc(5, 15, 59), utc(5, 16, 10), utc(5, 22, 0)]);
  assert.deepEqual(w.map((x) => [new Date(x.start).getUTCHours(), new Date(x.end).getUTCHours()]), [[11, 16], [16, 21], [22, 3]]);
});

test("weekly window: the next reset after now, and a new window starts exactly at the reset", () => {
  const anchor = utc(6, 14); // a Friday 14:00
  const w = weeklyWindow(utc(5, 12, 56), anchor);
  assert.equal(w.end, anchor);
  assert.equal(w.start, anchor - 7 * 24 * H);
  const next = weeklyWindow(anchor, anchor);
  assert.equal(next.start, anchor);
  assert.equal(next.end, anchor + 7 * 24 * H);
});

test("reset text: weekday + time means the next such moment; ISO passes through; nonsense is rejected", () => {
  const thursday = new Date(2026, 10, 5, 12, 56).getTime();
  const fri = new Date(parseResetSpec("fri 14:00", thursday));
  assert.equal(fri.getDay(), 5);
  assert.equal(fri.getHours(), 14);
  assert.ok(fri.getTime() > thursday && fri.getTime() - thursday < 7 * 24 * H);
  assert.equal(parseResetSpec("2026-11-06T14:00:00Z"), Date.parse("2026-11-06T14:00:00Z"));
  assert.equal(new Date(parseResetSpec("4:00 pm", thursday)).getHours(), 16);
  assert.equal(parseResetSpec("someday", thursday), null);
});

test("limits are the median of spend/percent over calibration points; tiny percentages are ignored", () => {
  const f = fitLimits([
    { spendFive: 17.4, fivePct: 60, spendWeek: 214.82, weeklyPct: 85 },
    { spendFive: 10, fivePct: 30, spendWeek: 100, weeklyPct: 40 },
    { spendFive: 0.5, fivePct: 2, spendWeek: 1, weeklyPct: 1 } // too small a percentage to trust
  ]);
  assert.equal(f.fiveHourPoints, 2);
  assert.ok(Math.abs(f.fiveHourUSD - (29 + 33.333) / 2) < 0.1);
  assert.ok(Math.abs(f.weeklyUSD - (252.73 + 250) / 2) < 0.5);
  assert.ok(f.fiveHourSpread.max > f.fiveHourSpread.min);
});

test("calibrate stores the logs' spend next to the app's percent, and the estimate reproduces the calibration point", () => {
  tempSparelimitHome();
  const events = [
    { t: utc(1, 8), cost: 40 },
    { t: utc(5, 11, 10), cost: 8 },
    { t: utc(5, 12, 30), cost: 9.4 } // 17.4 in the 11:00-16:00 window
  ];
  const at = utc(5, 12, 56);
  const point = addCalibrationPoint({ at, fivePct: 60, weeklyPct: 50, weeklyResetMs: utc(6, 14), events });
  assert.equal(point.spendFive, 17.4);
  assert.equal(point.spendWeek, 57.4);
  assert.ok(fs.existsSync(calibrationPath()));
  const est = estimatePlanUsage({ now: at, events, calibration: JSON.parse(fs.readFileSync(calibrationPath(), "utf8")) });
  assert.ok(Math.abs(est.fiveHour.pct - 60) < 0.5);
  assert.ok(Math.abs(est.weekly.pct - 50) < 0.5);
  assert.equal(est.confidence, "estimated");
  assert.equal(est.fiveHour.resetsInMin, 184);
});

test("with no activity in the current window the 5-hour estimate is 0%, and without calibration there are no numbers", () => {
  tempSparelimitHome();
  const events = [{ t: utc(5, 1), cost: 5 }];
  const cal = { points: [{ spendFive: 10, fivePct: 50, spendWeek: null, weeklyPct: null }] };
  const est = estimatePlanUsage({ now: utc(5, 20), events, calibration: cal });
  assert.equal(est.fiveHour.pct, 0);
  assert.equal(estimatePlanUsage({ now: utc(5, 20), events, calibration: { points: [] } }).fiveHour, null);
  assert.equal(spendIn(events, 0, utc(5, 2)), 5);
});
