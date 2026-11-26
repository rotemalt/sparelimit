import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, fixture, tempSparelimitHome } from "./helpers.mjs";

const sparelimitHome = tempSparelimitHome();
const homeWith = (withSession) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-"));
  if (withSession) {
    fs.mkdirSync(path.join(home, ".claude", "projects", "p"), { recursive: true });
    fs.copyFileSync(fixture("claude-code-session.jsonl"), path.join(home, ".claude", "projects", "p", "s.jsonl"));
  }
  return home;
};
const run = (home, args) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { encoding: "utf8", env: { ...process.env, HOME: home, SPARELIMIT_HOME: sparelimitHome } });

test("sparelimit coach --json: the card has three modelled savings and six spend-at-stake rows, every row labelled", () => {
  const r = run(homeWith(true), ["coach", "--json"]);
  assert.equal(r.status, 0, r.stderr);
  const card = JSON.parse(r.stdout);
  assert.equal(card.sessions, 1);
  assert.equal(card.savings.length, 3);
  assert.equal(card.atStake.length, 6);
  assert.ok([...card.savings, ...card.atStake].every((h) => ["estimated", "derived"].includes(h.confidence) && h.how));
});

test("sparelimit coach: with no history it says so and exits 1; the text card prints both lists", () => {
  const none = run(homeWith(false), ["coach"]);
  assert.equal(none.status, 1);
  assert.match(none.stderr, /found no Claude Code session logs/);
  const text = run(homeWith(true), ["coach"]);
  assert.match(text.stdout, /MODELLED SAVINGS/);
  assert.match(text.stdout, /WHERE ELSE THE SPEND IS/);
});

test("dashboard: /api/coach returns the card (computed off the main thread), and a clear 503 when there is no history", async () => {
  const { startServer } = await import("../sparelimit.mjs");
  const get = async (home) => {
    process.env.HOME = home;
    const server = startServer(null, null, 0);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/coach`);
      return { status: res.status, body: await res.json() };
    } finally {
      server.close();
    }
  };
  const log = console.log;
  console.log = () => {};
  try {
    const ok = await get(homeWith(true));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.savings.length, 3);
    const none = await get(homeWith(false));
    assert.equal(none.status, 503);
    assert.match(none.body.error, /no Claude Code transcripts/);
  } finally {
    console.log = log;
  }
});
