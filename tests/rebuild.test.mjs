import test from "node:test";
import assert from "node:assert/strict";
import { rebuildEvents, summarizeRebuild, REBUILD } from "../src/rebuild.mjs";

const T0 = Date.parse("2026-11-05T08:00:00Z");
const ev = (i, context, calls = [], extra = {}) => ({ id: `e${i}`, ts: new Date(T0 + i * 60e3).toISOString(), isSidechain: false, context, calls, ...extra });
const read = (sig, chars) => ({ name: "Read", sig, resChars: chars, res: "ok" });
// 5 responses at 100k, then a shrink to 20k, then 12 more
const session = (afterCalls) => [...[0, 1, 2, 3, 4].map((i) => ev(i, 100000, i < 2 ? [read(`Read:f${i}`, 3700)] : [])), ...Array.from({ length: 12 }, (_, k) => ev(5 + k, 20000 + k * 1000, afterCalls[k] || []))];

test("a shrink is followed for 10 responses: files read before are 're-read', other files are new, all tool output and growth are upper bounds", () => {
  const rows = rebuildEvents(session({ 0: [read("Read:f0", 37000), read("Read:new", 7400), { name: "Bash", sig: "b", resChars: 3700, res: "ok" }], 3: [read("Read:f1", 3700)] }));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { at: rows[0].at, contextBefore: 100000, contextAfter: 20000, reReadTokens: 11000, reReadFiles: 2, newReadTokens: 2000, toolOutputTokens: 14000, growthTokens: 10000 });
});

test("failed reads do not count; a shrink with fewer than 10 responses after it is skipped; same-file reads before the shrink only", () => {
  const failed = rebuildEvents(session({ 0: [{ name: "Read", sig: "Read:f0", resChars: 3700, res: "!x" }] }));
  assert.equal(failed[0].reReadTokens, 0);
  const short = session({}).slice(0, 12); // only 6 responses after the shrink
  assert.deepEqual(rebuildEvents(short), []);
  const sub = session({}).map((e, i) => (i === 7 ? { ...e, isSidechain: true } : e));
  assert.equal(rebuildEvents(sub).length, 1, "subagent responses are not part of the main conversation");
});

test("the summary gives the middle of the distribution beside the assumption, and says when there are too few shrinks", () => {
  const rows = [0, 0, 0, 10000, 30000].map((t) => ({ reReadTokens: t, newReadTokens: 0, toolOutputTokens: t * 2, growthTokens: t * 3 }));
  const s = summarizeRebuild(rows);
  assert.equal(s.events, 5);
  assert.equal(s.medianReReadTokens, 0);
  assert.equal(s.zeroShare, 60);
  assert.equal(s.modelAssumesTokens, 25000);
  assert.equal(s.enough, false);
  assert.match(s.confidence, /too few shrinks \(5 of 10 needed\)/);
  assert.equal(summarizeRebuild(Array(REBUILD.minEvents).fill(rows[0])).enough, true);
});
