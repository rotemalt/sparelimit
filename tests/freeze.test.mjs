import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkFreeze, readFreeze, FREEZE } from "../src/freeze.mjs";
import { handleHook } from "../src/hook.mjs";
import { writeJsonAtomic, overridePath, auditPath } from "../src/state.mjs";
import { tempSparelimitHome } from "./helpers.mjs";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const proj = (body) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-fz-"));
  if (body) fs.writeFileSync(path.join(d, FREEZE.file), JSON.stringify({ createdAt: new Date(NOW - 3600e3).toISOString(), ...body }));
  return d;
};
const edit = (cwd, file, tool = "Edit") => checkFreeze({ cwd, toolName: tool, toolInput: { file_path: file }, now: NOW });

test("with relative paths locked, only those files may be edited; the same name in another folder is blocked", () => {
  const d = proj({ lockedPaths: ["src/a.js"], lockedFiles: ["a.js"] });
  assert.equal(edit(d, path.join(d, "src/a.js")), null);
  assert.equal(edit(d, "src/a.js"), null, "a relative path in the call");
  const b = edit(d, path.join(d, "lib/a.js"));
  assert.match(b.message, /scope is frozen to src\/a\.js/);
  assert.match(b.message, /lib\/a\.js is not in it/);
  assert.match(b.message, /sparelimit freeze --off/);
  assert.match(b.message, /sparelimit allow/);
});

test("an old freeze file with names only is matched by file name", () => {
  const d = proj({ lockedFiles: ["a.js"] });
  assert.equal(edit(d, path.join(d, "deep/er/a.js")), null);
  assert.ok(edit(d, path.join(d, "b.js")));
});

test("only tools that write a file are checked; unreadable paths, other projects and non-strings pass", () => {
  const d = proj({ lockedPaths: ["a.js"] });
  assert.equal(checkFreeze({ cwd: d, toolName: "Read", toolInput: { file_path: path.join(d, "x.js") }, now: NOW }), null);
  assert.equal(checkFreeze({ cwd: d, toolName: "Bash", toolInput: { command: "echo > x.js" }, now: NOW }), null, "a shell command is not guessed at");
  assert.equal(checkFreeze({ cwd: d, toolName: "Edit", toolInput: {}, now: NOW }), null);
  assert.equal(checkFreeze({ cwd: d, toolName: "Edit", toolInput: { file_path: 5 }, now: NOW }), null);
  assert.equal(edit(d, "/somewhere/else/x.js"), null, "outside this project");
  assert.ok(edit(d, path.join(d, "x.js"), "Write"));
  assert.ok(edit(d, path.join(d, "x.js"), "MultiEdit"));
});

test("a freeze expires, an empty or broken one does nothing, and there is none without the file", () => {
  assert.equal(readFreeze(proj({ lockedPaths: ["a.js"], createdAt: new Date(NOW - 9 * 3600e3).toISOString() }), NOW), null, "9 hours old, 8 allowed");
  assert.ok(readFreeze(proj({ lockedPaths: ["a.js"], createdAt: new Date(NOW - 9 * 3600e3).toISOString(), ttlHours: 12 }), NOW), "its own ttl applies");
  assert.equal(readFreeze(proj({ lockedPaths: [], lockedFiles: [] }), NOW), null);
  assert.equal(readFreeze(proj({ lockedPaths: ["a.js"], createdAt: "not a date" }), NOW), null);
  const bad = proj();
  fs.writeFileSync(path.join(bad, FREEZE.file), "{broken");
  assert.equal(readFreeze(bad, NOW), null);
  assert.equal(readFreeze(proj(), NOW), null);
  assert.equal(readFreeze(undefined, NOW), null);
});

test("the hook refuses the edit with exit 2 and logs it; an override lets it through; reads and other projects are untouched", () => {
  tempSparelimitHome();
  const d = proj({ lockedPaths: ["a.js"] });
  const call = (tool, file, extra = {}) => handleHook("pretooluse", { session_id: "s1", cwd: d, tool_name: tool, tool_input: { file_path: file }, ...extra }, { now: NOW });
  const r = call("Edit", path.join(d, "other.js"));
  assert.equal(r.exit, 2);
  assert.match(r.stderr, /scope is frozen/);
  const rows = fs.readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((x) => [x.kind, x.rule, x.level]), [["finding", "scope.frozen", "block"]]);
  assert.equal(call("Edit", path.join(d, "a.js")).exit, 0);
  assert.equal(call("Read", path.join(d, "other.js")).exit, 0);
  writeJsonAtomic(overridePath(), { all: NOW + 60e3 });
  assert.equal(call("Edit", path.join(d, "other.js")).exit, 0, "sparelimit allow lifts it for a while");
});
