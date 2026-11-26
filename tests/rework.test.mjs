import test from "node:test";
import assert from "node:assert/strict";
import { findRework, REWORK } from "../src/rework.mjs";
import { buildWhy } from "../src/why.mjs";

const edit = (file, cost = 1) => ({ cost, ev: { calls: [{ name: "Edit", sig: `Edit:${Math.random()}`, file }] } });
const bash = (sig, failed, cost = 1) => ({ cost, ev: { calls: [{ name: "Bash", sig, res: `${failed ? "!" : ""}abc` }] } });
const idle = (cost = 1) => ({ cost, ev: { calls: [{ name: "Read", sig: "Read:x" }] } });

test("a file edited 4+ times in nearby responses is a rewrite loop; the first edit is the work, the later ones are priced", () => {
  const events = [edit("/p/a.js"), idle(), edit("/p/a.js"), idle(), edit("/p/a.js"), edit("/p/a.js", 2), edit("/p/b.js"), edit("/p/b.js")];
  const r = findRework(events);
  assert.deepEqual(r.rewriteLoops, [{ file: "a.js", edits: 4, spanResponses: 6, costUSD: 4 }], "b.js was edited twice: not a loop; a.js: later edits cost 1 + 1 + 2");
  assert.equal(r.rewriteLoopUSD, 4);
  assert.equal(r.confidence, "derived");
});

test("edits far apart are separate runs, and subagent responses do not count", () => {
  const far = [edit("/p/a.js"), edit("/p/a.js"), ...Array.from({ length: REWORK.gapResponses + 1 }, () => idle()), edit("/p/a.js"), edit("/p/a.js")];
  assert.deepEqual(findRework(far).rewriteLoops, [], "two runs of two edits each");
  const side = Array.from({ length: 6 }, () => ({ cost: 1, ev: { isSidechain: true, calls: [{ name: "Edit", sig: "e", file: "/p/a.js" }] } }));
  assert.deepEqual(findRework(side).rewriteLoops, []);
});

test("the same command failing 3+ times is a failing repeat; a different command, or a success, is not", () => {
  const events = [bash("Bash:1", true), bash("Bash:1", true, 2), bash("Bash:1", false), bash("Bash:1", true, 3), bash("Bash:2", true), bash("Bash:2", true)];
  const r = findRework(events);
  assert.deepEqual(r.failingRepeats, [{ tool: "Bash", times: 3, costUSD: 5 }]);
  assert.equal(r.failingRepeatUSD, 5);
});

test("a response with several calls shares its cost between them, and the why engine lists both causes", () => {
  const multi = { cost: 10, ev: { calls: [{ name: "Edit", sig: "a", file: "/p/a.js" }, { name: "Edit", sig: "b", file: "/p/a.js" }] } };
  const r = findRework([multi, edit("/p/a.js", 10), edit("/p/a.js", 10)]);
  assert.equal(r.rewriteLoops[0].edits, 4);
  assert.equal(r.rewriteLoops[0].costUSD, 5 + 10 + 10, "the second call of the first response (5) and the two later responses");
  const why = buildWhy({ totalCostUSD: 100, rework: { ...r, failingRepeats: [{ tool: "Bash", times: 3, costUSD: 4 }], failingRepeatUSD: 4 } });
  assert.deepEqual(why.causes.map((c) => c.id).sort(), ["rework.edits", "rework.failing"]);
});
