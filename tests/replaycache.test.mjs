import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cachedReplay, pruneReplayCache, logSignature, fingerprint } from "../src/replaycache.mjs";
import { stateDir } from "../src/state.mjs";
import { tempSparelimitHome } from "./helpers.mjs";

const mkLog = (body = "{}\n") => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-rc-"));
  const f = path.join(d, "s1.jsonl");
  fs.writeFileSync(f, body);
  return f;
};
const counter = (value = { total: 1 }) => {
  const c = { n: 0, fn: () => (c.n++, value) };
  return c;
};

test("the second call for an unchanged log reads the cache instead of computing; the result is the same", () => {
  tempSparelimitHome();
  const f = mkLog();
  const c = counter({ sessionId: "s1", total: 4.2, timeline: [{ t: 1, cost: 0.5 }] });
  const a = cachedReplay(f, c.fn);
  const b = cachedReplay(f, c.fn);
  assert.equal(c.n, 1);
  assert.deepEqual(b, a);
});

test("a log that changed (size or time), or one with a changed subagent file, is computed again", () => {
  tempSparelimitHome();
  const f = mkLog("{}\n");
  const c = counter();
  cachedReplay(f, c.fn);
  fs.appendFileSync(f, "{}\n");
  cachedReplay(f, c.fn);
  assert.equal(c.n, 2);
  const sub = path.join(path.dirname(f), "s1", "subagents");
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(path.join(sub, "agent-a.jsonl"), "{}\n");
  assert.notEqual(logSignature(f), logSignature(mkLog()));
  cachedReplay(f, c.fn);
  assert.equal(c.n, 3, "a new subagent file changes the signature though the main file did not");
  cachedReplay(f, c.fn);
  assert.equal(c.n, 3);
});

test("a different fingerprint (the code or the prices changed) invalidates the entry", () => {
  tempSparelimitHome();
  const f = mkLog();
  const c = counter();
  cachedReplay(f, c.fn, { fp: "aaaa" });
  cachedReplay(f, c.fn, { fp: "aaaa" });
  assert.equal(c.n, 1);
  cachedReplay(f, c.fn, { fp: "bbbb" });
  assert.equal(c.n, 2);
  assert.match(fingerprint(), /^[0-9a-f]{16}$/);
  const h = tempSparelimitHome();
  const before = fingerprint();
  fs.writeFileSync(path.join(process.env.SPARELIMIT_HOME || stateDir(), "pricing.json"), JSON.stringify({ models: { x: { input: 1, output: 1 } } }));
  assert.notEqual(fingerprint(), before, "your own price overrides are part of what produced a result");
  void h;
});

test("a damaged entry is recomputed, a null result is not stored, and SPARELIMIT_NO_CACHE skips the cache", () => {
  tempSparelimitHome();
  const f = mkLog();
  const c = counter();
  cachedReplay(f, c.fn);
  const dir = path.join(stateDir(), "replay-cache");
  for (const e of fs.readdirSync(dir)) fs.writeFileSync(path.join(dir, e), "{broken");
  cachedReplay(f, c.fn);
  assert.equal(c.n, 2);
  const nul = counter(null);
  const g = mkLog("{}\n{}\n");
  cachedReplay(g, nul.fn);
  cachedReplay(g, nul.fn);
  assert.equal(nul.n, 2, "nothing stored for null");
  process.env.SPARELIMIT_NO_CACHE = "1";
  try {
    cachedReplay(f, c.fn);
    cachedReplay(f, c.fn);
    assert.equal(c.n, 4);
  } finally {
    delete process.env.SPARELIMIT_NO_CACHE;
  }
});

test("pruning removes entries for logs no longer in the run, and keeps the ones that were", () => {
  tempSparelimitHome();
  const [a, b] = [mkLog("{}\n"), mkLog("{}\n{}\n")];
  const seenBoth = new Set();
  cachedReplay(a, counter().fn, { touched: seenBoth });
  cachedReplay(b, counter().fn, { touched: seenBoth });
  const dir = path.join(stateDir(), "replay-cache");
  assert.equal(fs.readdirSync(dir).length, 2);
  const onlyA = new Set();
  cachedReplay(a, counter().fn, { touched: onlyA });
  pruneReplayCache(onlyA);
  assert.equal(fs.readdirSync(dir).length, 1);
  const c = counter();
  cachedReplay(a, c.fn);
  assert.equal(c.n, 0, "the kept entry still serves");
});

test("a log that cannot be read is computed without a cache entry, not an error", () => {
  tempSparelimitHome();
  const c = counter({ ok: 1 });
  assert.deepEqual(cachedReplay("/no/such/log.jsonl", c.fn), { ok: 1 });
  assert.equal(c.n, 1);
});
