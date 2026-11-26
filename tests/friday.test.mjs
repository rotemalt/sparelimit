import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./helpers.mjs";
import { fridayBlock } from "../scripts/friday.mjs";
import { scan } from "../src/safeshare.mjs";

const numbersFile = path.join(ROOT, "site", "numbers.json");
const card = JSON.parse(fs.readFileSync(numbersFile, "utf8"));

test("the Friday block has a fixed shape: nine lines, every figure labelled, the breakdown adds up, no prose", () => {
  const lines = fridayBlock(card).split("\n");
  assert.equal(lines.length, 9);
  assert.match(lines[0], /^Sparelimit, numbers of \d{4}-\d{2}-\d{2}$/);
  assert.match(lines[1], /^Scope: one machine, one person, first weeks of use; rules version \d+$/);
  assert.match(lines[2], /^Alerts that fired: \d+ \[derived\]$/);
  const m = lines[3].match(/^Where they went: (.+) = (\d+) \[derived\]$/);
  assert.ok(m, lines[3]);
  assert.equal([...m[1].matchAll(/(\d+) /g)].reduce((n, x) => n + Number(x[1]), 0), Number(m[2]));
  assert.equal(Number(m[2]), Number(lines[2].match(/\d+/)[0]), "the total is the alerts that fired");
  assert.match(lines[5], /^Counted saving: \$[\d,]+\.\d{2} \[estimated\], API-equivalent at list price$/);
  assert.match(lines[8], /sparelimit week --days=0 --share$/);
  assert.doesNotMatch(fridayBlock(card), /!|saved you|money saved|revolution|game-chang/i);
});

test("the Friday block is share-safe: the scanner finds nothing", () => {
  assert.deepEqual(scan(fridayBlock(card), { names: [os.userInfo().username, os.hostname().split(".")[0]] }), []);
});

test("npm run friday exists and prints the block (without rewriting the numbers when told not to)", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts.friday, "node scripts/friday.mjs");
  const before = fs.readFileSync(numbersFile, "utf8");
  const r = spawnSync(process.execPath, [path.join(ROOT, "scripts", "friday.mjs"), "--no-write"], { encoding: "utf8", cwd: ROOT });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), fridayBlock(card));
  assert.match(r.stderr, /go-out-check: /);
  assert.equal(fs.readFileSync(numbersFile, "utf8"), before, "--no-write leaves the numbers alone");
});
