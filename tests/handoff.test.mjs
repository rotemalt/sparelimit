import test from "node:test";
import assert from "node:assert/strict";
import { buildHandoff } from "../src/handoff.mjs";
import { HIDDEN_GOAL } from "../src/redact.mjs";

const session = {
  userTurns: [{ text: "first: build the importer" }, { text: "second: use the v2 API" }, { text: "third: now fix the failing parse test, key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
  commandResults: [
    { command: "npm test", ok: false, summary: "parse.test.js: expected 2 got 3" },
    { command: "npm run lint", ok: false, summary: "no-unused-vars" },
    { command: "npm run lint", ok: true, summary: "" },
    { command: "node build.js", ok: false, summary: "" }
  ],
  fileTouches: [
    { file: "/p/src/parse.js", kind: "read", id: "1", range: "40-139" }, { file: "/p/src/parse.js", kind: "read", id: "2", range: "200-299" },
    { file: "/p/src/parse.js", kind: "write", id: "3" }, { file: "/p/src/parse.js", kind: "write", id: "3" },
    { file: "/p/src/api.js", kind: "read", id: "4" }, { file: "/var/folders/x/tmp.js", kind: "write", id: "5" }
  ]
};

test("the handoff keeps the old first line and goal line, and adds earlier asks, files in play with read ranges, and what is still failing", () => {
  const h = buildHandoff(session);
  assert.match(h.prompt, /^Continue task in parse\.js, api\.js:\n- Goal from previous session: "third: now fix the failing parse test, key \[hidden/);
  assert.match(h.prompt, /Before that you asked: "first: build the importer" \/ "second: use the v2 API"/);
  assert.match(h.prompt, /parse\.js \(read 2×, edited 1×\), lines read last: 40-139; 200-299/, "a write repeated under one tool id counts once");
  assert.doesNotMatch(h.prompt, /tmp\.js/);
  assert.match(h.prompt, /Still failing[\s\S]*`npm test`: parse\.test\.js: expected 2 got 3[\s\S]*`node build\.js`/);
  assert.doesNotMatch(h.prompt, /npm run lint/, "it failed and then passed");
  assert.doesNotMatch(h.prompt, /sk-ant-api03-AAAA/, "secrets are scrubbed");
});

test("the hidden variant carries none of your words, but keeps the files and the failures", () => {
  const h = buildHandoff(session);
  assert.ok(h.hidden.includes(HIDDEN_GOAL));
  assert.doesNotMatch(h.hidden, /first: build|second: use|third: now/);
  assert.match(h.hidden, /parse\.js \(read 2×/);
  assert.match(h.hidden, /`npm test`/);
});

test("a thin session still gives a usable handoff", () => {
  const h = buildHandoff({ userTurns: [], commandResults: [], fileTouches: [] });
  assert.match(h.prompt, /^Continue task in target file:\n- Goal from previous session: "Continue implementation"\n- Focus ONLY on: target file\n- Constraints:/);
});
