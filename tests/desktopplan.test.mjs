import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readDesktopPlanSamples, desktopPlanPath, checkAgainstLogs, usableFiveHour } from "../src/desktopplan.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-dp-"));
const write = (name, body) => {
  const f = path.join(dir, name);
  fs.writeFileSync(f, typeof body === "string" ? body : JSON.stringify(body));
  return f;
};
const T0 = Date.parse("2026-11-01T10:00:00Z");
const H = 3600e3;
const sample = (t, fh, sd, org = "org-secret-id") => ({ t, org, u: { fh, sd } });

test("the reader keeps times and percentages, drops the organisation id, and sorts oldest first", () => {
  const f = write("ok.json", { version: 2, samples: [sample(T0 + H, 40, 10), sample(T0, 100, 5)] });
  const out = readDesktopPlanSamples({ file: f });
  assert.deepEqual(out, [{ t: T0, fiveHourPct: 100, weeklyPct: 5 }, { t: T0 + H, fiveHourPct: 40, weeklyPct: 10 }]);
  assert.doesNotMatch(JSON.stringify(out), /org-secret/);
});

test("a file in the wrong shape gives nothing, and bad samples are skipped one by one", () => {
  assert.deepEqual(readDesktopPlanSamples({ file: path.join(dir, "missing.json") }), []);
  assert.deepEqual(readDesktopPlanSamples({ file: write("junk.json", "{not json") }), []);
  assert.deepEqual(readDesktopPlanSamples({ file: write("v3.json", { version: 3, samples: [sample(T0, 10, 10)] }) }), [], "an unknown version is not guessed at");
  assert.deepEqual(readDesktopPlanSamples({ file: write("nosamples.json", { version: 2 }) }), []);
  const f = write("mixed.json", { version: 2, samples: [sample(T0, 150, 10), sample(T0, "40", 10), sample("x", 10, 10), sample(Date.now() + 9e9, 10, 10), null, { t: T0, u: {} }, sample(T0, -1, 200), sample(T0 + 1, 33, 44)] });
  // a sample with one bad figure keeps the other (null for the bad one); a sample with neither, a bad time or a non-object is dropped
  assert.deepEqual(readDesktopPlanSamples({ file: f }), [{ t: T0, fiveHourPct: null, weeklyPct: 10 }, { t: T0, fiveHourPct: null, weeklyPct: 10 }, { t: T0 + 1, fiveHourPct: 33, weeklyPct: 44 }]);
});

test("the path is the app's own folder on each system", () => {
  assert.equal(desktopPlanPath({ platform: "darwin", home: "/Users/a" }), "/Users/a/Library/Application Support/Claude/plan-usage-history.json");
  assert.equal(desktopPlanPath({ platform: "win32", home: "C:\\Users\\a", env: { APPDATA: "C:\\A" } }), path.join("C:\\A", "Claude", "plan-usage-history.json"));
  assert.equal(desktopPlanPath({ platform: "linux", home: "/home/a", env: {} }), "/home/a/.config/Claude/plan-usage-history.json");
});

test("only samples between 15% and 95% can calibrate: 0 and 100 are clamps", () => {
  const s = [100, 0, 14, 15, 60, 95, 96].map((p, i) => ({ t: T0 + i, fiveHourPct: p, weeklyPct: null }));
  assert.deepEqual(usableFiveHour(s).map((x) => x.fiveHourPct), [15, 60, 95]);
});

test("leave-one-out check: each sample is estimated from a limit fitted on the others; a window with no logged spend is reported as unseen", () => {
  // limit about $100 per window: spend 20 -> 20%, 40 -> 40%, 60 -> 60%; the fourth window has no spend in the logs
  const mk = (day, spend, pct) => ({ events: [{ t: day + 1 * H, cost: spend }], sample: { t: day + 2 * H, fiveHourPct: pct, weeklyPct: null } });
  const days = [0, 1, 2, 3].map((d) => T0 + d * 86400e3);
  const parts = [mk(days[0], 20, 20), mk(days[1], 40, 40), mk(days[2], 60, 60)];
  const samples = [...parts.map((p) => p.sample), { t: days[3] + 2 * H, fiveHourPct: 30, weeklyPct: null }];
  const r = checkAgainstLogs(samples, parts.flatMap((p) => p.events));
  assert.equal(r.usable, 4);
  assert.equal(r.scored, 3);
  assert.equal(r.unseen, 1);
  assert.equal(r.medianAbsErrorPoints, 0);
  assert.equal(r.withinTenPoints, 3);
  assert.match(r.confidence, /small check \(3 samples\)/);
});
