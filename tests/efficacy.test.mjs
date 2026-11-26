import test from "node:test";
import assert from "node:assert/strict";
import { buildEfficacy } from "../src/efficacy.mjs";

const T0 = Date.parse("2026-11-07T10:00:00Z");
const MIN = 60e3;
const row = (min, rule, sessionId = "s1", kind = "finding") => ({ t: new Date(T0 + min * MIN).toISOString(), kind, rule, sessionId });
const evs = (list) => list.map(([min, cost, side]) => ({ t: T0 + min * MIN, cost, side }));
const now = T0 + 5 * 3600e3;

test("per rule: the pace after against the pace before, with sessions that went quiet counted apart", () => {
  const timeline = evs([[-12, 1], [-8, 1], [-3, 1], [4, 0.5], [9, 0.5]]); // 3.0 before, 1.0 after: slowed
  const rise = evs([[-12, 1], [-8, 1], [-3, 1], [4, 3], [9, 3]]); // 3 before, 6 after: rose
  const quiet = evs([[-12, 1], [-8, 1], [-3, 1]]);
  const held = evs([[-12, 1], [-8, 1], [-3, 1], [4, 1.5], [9, 1.5]]);
  const r = buildEfficacy([row(0, "context.window", "a"), row(0, "context.window", "b"), row(0, "context.window", "c"), row(0, "context.window", "d")], [
    { sessionId: "a", timeline }, { sessionId: "b", timeline: rise }, { sessionId: "c", timeline: quiet }, { sessionId: "d", timeline: held }
  ], { now });
  assert.deepEqual(r.rules, [{ rule: "context.window", measured: 3, slowed: 1, held: 1, rose: 1, quiet: 1, tooRecent: 0, noData: 0 }]);
  assert.equal(r.confidence, "derived");
});

test("a message repeated inside the window counts once; subagent responses, thin history, unknown sessions and recent messages are set aside", () => {
  const timeline = evs([[-12, 1], [-8, 1], [-3, 1], [4, 0.5], [6, 9, true]]);
  const r = buildEfficacy([row(0, "r1"), row(2, "r1"), row(5, "r1"), row(0, "r2", "thin"), row(0, "r3", "ghost"), row(4 * 60 + 55, "r4")], [
    { sessionId: "s1", timeline: [...timeline, ...evs([[300 - 10, 1], [300 - 8, 1], [300 - 6, 1]])] },
    { sessionId: "thin", timeline: evs([[-3, 1], [4, 1]]) }
  ], { now });
  const by = Object.fromEntries(r.rules.map((x) => [x.rule, x]));
  assert.equal(by.r1.measured + by.r1.quiet, 1, "rows at 0, 2 and 5 minutes are one intervention: each is within 15 minutes of the one counted");
  assert.equal(by.r2.noData, 1);
  assert.equal(by.r3.noData, 1);
  assert.equal(by.r4.tooRecent, 1);
});
