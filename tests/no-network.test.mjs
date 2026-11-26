import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./helpers.mjs";

/**
 * The privacy claim "the local tool sends nothing anywhere" (README, SECURITY.md, site/privacy.html) as a check on the code: nothing under
 * src/ or sparelimit.mjs may open a connection to anywhere. The one place that fetches over the network is scripts/build-pricing.mjs, a command
 * you run by hand to refresh the price list, and it is named here so that adding another is a visible decision.
 */
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".mjs") ? [path.join(dir, e.name)] : []));
const files = [path.join(ROOT, "sparelimit.mjs"), ...walk(path.join(ROOT, "src"))];
const CLIENT = /\bfetch\s*\(|node:https\b|node:net\b|node:dgram\b|node:tls\b|node:http2\b|\bhttps?\.(request|get)\b|new\s+WebSocket\b|XMLHttpRequest|\bnet\.(connect|createConnection)\b/;

test("no code in the shipped tool opens an outbound connection", () => {
  const hits = files.flatMap((f) => fs.readFileSync(f, "utf8").split("\n").map((l, i) => [f, i + 1, l]).filter(([, , l]) => CLIENT.test(l) && !/^\s*(\/\/|\*)/.test(l)).map(([f2, n]) => `${path.relative(ROOT, f2)}:${n}`));
  assert.deepEqual(hits, []);
});

test("the only HTTP code in the tool is the local dashboard server, bound to the loopback address", () => {
  const users = files.filter((f) => /node:http\b/.test(fs.readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(users, [path.join("src", "server.mjs")]);
  assert.match(fs.readFileSync(path.join(ROOT, "src", "server.mjs"), "utf8"), /listen\([^)]*127\.0\.0\.1/);
});

test("the only scripts that fetch are the price-list refresh you run by hand and the optional count (off by default)", () => {
  const scripts = walk(path.join(ROOT, "scripts")).filter((f) => /\bfetch\s*\(/.test(fs.readFileSync(f, "utf8"))).map((f) => path.basename(f));
  assert.deepEqual(scripts, ["build-pricing.mjs"]);
  // count-ping.mjs takes its fetch as a parameter (so tests can watch it); it is named here so that it stays a visible decision
  assert.match(fs.readFileSync(path.join(ROOT, "scripts", "count-ping.mjs"), "utf8"), /fetchImpl = fetch/);
});
