import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scan, summarize } from "../src/safeshare.mjs";
import { ROOT, fixture, tempSparelimitHome } from "./helpers.mjs";

const sparelimitHome = tempSparelimitHome();
const kinds = (t, names) => summarize(scan(t, { names })).map((f) => f.kind);

test("it finds home paths, emails, session ids, short session ids and exact times", () => {
  const text = ["opened /Users/jane/Clients/acme/app.ts", "write to jane@example.com", "session 1a2b3c4d-1111-2222-3333-444455556666", "top: 82728f08…  994 min", "at 2026-11-05T14:32:48.462Z and 2026-11-05 14:32"].join("\n");
  assert.deepEqual(kinds(text).sort(), ["email address", "exact time", "home path", "session id", "short session id"].sort());
});

test("it finds credential shapes and the names of this machine's user, computer and projects, and never prints a whole value", () => {
  const text = "key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA for the Zebra-Billing project";
  const f = summarize(scan(text, { names: ["Zebra-Billing", "x", "src"] }));
  assert.deepEqual(f.map((x) => x.kind).sort(), ["a name from this machine", "credential shape"]);
  for (const x of f) assert.ok(!/AAAAAAAA|Zebra-Billing/.test(x.sample), "samples are masked");
});

test("short and generic names are not flagged, so a clean file stays clean", () => {
  assert.deepEqual(kinds("the src folder in downloads, v1.0 for me", ["src", "Downloads", "me", "app"]), []);
});

test("counts, lines and a clean result for numbers only", () => {
  const f = summarize(scan("a\n2026-11-05 10:00\nb\n2026-11-05 11:00", {}));
  assert.deepEqual([f[0].n, f[0].lines], [2, [2, 4]]);
  assert.deepEqual(scan("89 alerts, 3 acted on, $19.56 counted, $0.98 at 5%. From 2026-11-18 to 2026-11-25.", {}), [], "dates without a time are not exact times");
});

test("the command: not clean exits 1 and lists the kinds, clean exits 0, an image is not checked and exits 3, a missing file exits 1", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-share-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-"));
  fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
  fs.copyFileSync(fixture("claude-code-session.jsonl"), path.join(home, ".claude", "projects", "p", "s.jsonl"));
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), "safe-to-share", ...a], { encoding: "utf8", env: { ...process.env, HOME: home, SPARELIMIT_HOME: sparelimitHome } });
  fs.writeFileSync(path.join(dir, "bad.txt"), "mail me: a@b.co\n/Users/jane/x");
  fs.writeFileSync(path.join(dir, "good.txt"), "89 alerts, $19.56 counted");
  fs.writeFileSync(path.join(dir, "pic.png"), "x");
  const bad = run(path.join(dir, "bad.txt"));
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /NOT clean/);
  assert.match(bad.stdout, /email address/);
  assert.match(bad.stdout, /home path/);
  assert.ok(!bad.stdout.includes("a@b.co"), "the address itself is not printed");
  assert.equal(JSON.parse(run(path.join(dir, "bad.txt"), "--json").stdout).clean, false);
  assert.equal(run(path.join(dir, "good.txt")).status, 0);
  const img = run(path.join(dir, "pic.png"));
  assert.equal(img.status, 3);
  assert.match(img.stdout, /NOT checked/);
  assert.equal(run(path.join(dir, "nope.txt")).status, 1);
  assert.equal(fs.readFileSync(path.join(dir, "bad.txt"), "utf8"), "mail me: a@b.co\n/Users/jane/x", "the file is not changed");
});

test("the printed outputs that are meant to be shared are clean, and the ones that are not meant to be shared say what they hold", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-"));
  fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
  fs.copyFileSync(fixture("claude-code-session.jsonl"), path.join(home, ".claude", "projects", "p", "s.jsonl"));
  const env = { ...process.env, HOME: home, SPARELIMIT_HOME: sparelimitHome };
  const week = spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), "week"], { encoding: "utf8", env }).stdout;
  assert.deepEqual(scan(week, {}), [], "sparelimit week prints none of what the scanner looks for");
  assert.deepEqual(scan(fs.readFileSync(path.join(ROOT, "site", "numbers.json"), "utf8"), {}), [], "the published numbers hold none of it either");
});
