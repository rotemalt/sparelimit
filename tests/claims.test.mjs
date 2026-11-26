import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ROOT } from "./helpers.mjs";
import { METHOD, NOT_CLAIMED, renderMethodText } from "../src/method.mjs";

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

test("what Sparelimit does not claim: the README and the methodology page carry every sentence, from one list", () => {
  const readme = read("README.md");
  const page = read("site", "methodology.html");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  assert.ok(NOT_CLAIMED.length >= 5);
  for (const c of NOT_CLAIMED) {
    assert.ok(readme.includes(`**${c.lead}** ${c.text}`), `README is missing: ${c.lead} (run the claims text again from src/method.mjs)`);
    assert.ok(page.includes(esc(c.lead)) && page.includes(esc(c.text)), `methodology page is missing: ${c.lead}`);
  }
  assert.ok(METHOD.sections.some((s) => s.id === "does-not-claim"));
  assert.match(renderMethodText(METHOD, "does-not-claim"), /not proof of cause/);
});

test("the statements say the things the plan requires", () => {
  const all = NOT_CLAIMED.map((c) => `${c.lead} ${c.text}`).join("\n");
  for (const must of [/not proof of cause/, /author's choices|author wrote/, /assumes the earlier pace would have continued/, /all three counted savings/, /limit kept, not cash/, /one machine, one person/i]) assert.match(all, must);
});

test("the plan-limit statement matches the data it describes: the counted savings in the published numbers all come from one method, as stated", () => {
  const n = JSON.parse(read("site", "numbers.json"));
  const counted = n.breakdown.parts.find((p) => p.id === "counted").n;
  assert.equal(counted, 3, "the statement says all three; if the count on the card changed, say so in NOT_CLAIMED and date it");
  assert.equal(n.as_of, "2026-11-26", "the statement is dated 2026-11-26; update both when the numbers are refreshed");
});

test("public pages make no claim of proof, of first place or of certainty", () => {
  const files = ["README.md", path.join("site", "index.html")];
  const strong = /proves what it saved|to prove it worked|\bproof of savings\b|nobody (else )?(measures|shows|tracks)|\bthe only tool\b|\bguaranteed? (to )?sav/i;
  for (const f of files) assert.doesNotMatch(read(f), strong, f);
});

test("the comparison is dated, links its sources, says CodeBurn re-measures, and is linked from the README", () => {
  const t = read("docs", "COMPARISON.md");
  assert.match(t, /Read on 2026-11-26/);
  for (const u of ["getagentseal/codeburn/main/README.md", "github.com/ryoppippi/ccusage", "code.claude.com/docs/en/costs", "code.claude.com/docs/en/statusline"]) assert.ok(t.includes(u), u);
  assert.match(t, /CodeBurn re-measures after a fix/);
  assert.match(t, /No code from any of them was installed or run/);
  assert.match(t, /not verified/i);
  assert.match(read("README.md"), /docs\/COMPARISON\.md/);
});


test("go-out-check never prints a private path", () => {
  assert.doesNotMatch(read("scripts", "go-out-check.mjs"), new RegExp(["vera" + "rail-hq", "\\/Users\\/", "\\.private\\/"].join("|")));
});

test("the public tree does not name the other project: the word appears only inside the contact address the owner chose", () => {
  const word = new RegExp("vera" + "rail", "i");
  const contact = "rotem.alt.verarail@gmail.com"; // the address the owner chose to keep
  const files = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n").filter((f) => /\.(md|html|mjs|js|json|yml|yaml|php|sh|txt)$/.test(f) && f !== "package-lock.json");
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, f), "utf8").split(contact).join("");
    if (word.test(text)) hits.push(f);
    if (word.test(f)) hits.push(f);
  }
  assert.deepEqual(hits, [], "remove the name from these files, or from their names");
});

test("nothing paid and no other project's ideas are in the public tree", () => {
  const files = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n").filter((f) => /\.(md|html|mjs|js|json|yml|sh)$/.test(f) && !f.startsWith("tests/") && !f.startsWith("data/"));
  const bad = /freelancer|shelf|paying switch|licen[cs]e key|\bactivate <|(?<!\d)5% of|test balance|price it AI work|AI work will be priced|card\.json|pay-send/i;
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), "utf8"), bad, f);
});
