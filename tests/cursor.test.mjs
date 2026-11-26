import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cursorDbPath, readCursorMessages, summarizeCursor } from "../src/cursorreport.mjs";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const day = (/** @type {string} */ d) => Date.parse(`${d}T10:00:00Z`);

test("the database is looked for where Cursor keeps it on each system, and CURSOR_DB overrides", () => {
  assert.equal(cursorDbPath({ platform: "darwin", home: "/h", env: {} }), "/h/Library/Application Support/Cursor/User/globalStorage/state.vscdb");
  assert.equal(cursorDbPath({ platform: "linux", home: "/h", env: {} }), "/h/.config/Cursor/User/globalStorage/state.vscdb");
  assert.equal(cursorDbPath({ platform: "linux", home: "/h", env: { CURSOR_DB: "/x/y.db" } }), "/x/y.db");
});

test("messages are read from the sqlite3 output; bad numbers and timestamps become zero and unknown", () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-cursor-")), "state.vscdb");
  fs.writeFileSync(f, "");
  let seen = [];
  const rows = readCursorMessages(f, (args) => {
    seen = args;
    return JSON.stringify([{ composerId: "c1", input: 100, output: 5, ts: day("2026-11-06"), model: "gpt-x" }, { composerId: "c2", input: "x", output: 7, ts: 12, model: "" }]);
  });
  assert.match(seen[1], /mode=ro&immutable=1/, "opened read-only so Cursor's file is never changed");
  assert.deepEqual(rows[0], { composerId: "c1", input: 100, output: 5, ts: day("2026-11-06"), model: "gpt-x" });
  assert.deepEqual(rows[1], { composerId: "c2", input: 0, output: 7, ts: null, model: null });
  assert.deepEqual(readCursorMessages(f, () => ""), [], "an empty result is an empty list");
});

test("a missing file and a missing sqlite3 program give a plain message, not a stack trace", () => {
  assert.throws(() => readCursorMessages("/nonexistent/state.vscdb"), /No Cursor data at/);
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-cursor-")), "state.vscdb");
  fs.writeFileSync(f, "");
  assert.throws(() => readCursorMessages(f, () => { throw Object.assign(new Error("spawn"), { code: "ENOENT" }); }), /`sqlite3` program is needed/);
});

test("the summary adds tokens per session, day and model, shows no dollars, and counts what has no model or date", () => {
  const msgs = [
    { composerId: "a", input: 1000, output: 100, ts: day("2026-11-06"), model: "m1" },
    { composerId: "a", input: 500, output: 50, ts: day("2026-11-06"), model: null },
    { composerId: "b", input: 9000, output: 900, ts: null, model: null },
    { composerId: "c", input: 10, output: 1, ts: day("2025-01-01"), model: null }
  ];
  const s = summarizeCursor(msgs, { now: NOW });
  assert.equal(s.sessions, 3);
  assert.equal(s.messages, 4);
  assert.deepEqual(s.tokens, { input: 10510, output: 1051, total: 11561 });
  assert.equal(s.messagesWithoutModel, 3);
  assert.equal(s.messagesWithoutDate, 1);
  assert.deepEqual(s.byModel, [{ model: "m1", tokens: 1100 }]);
  assert.deepEqual(s.last14Days, [{ day: "2026-11-06", tokens: 1650 }], "only the last 14 days, and undated messages are left out");
  assert.equal(s.top[0].id, "b", "the largest session first");
  assert.equal(s.costUSD, null, "no dollar figure is invented");
  assert.equal(summarizeCursor([], { now: NOW }).sessions, 0);
});
