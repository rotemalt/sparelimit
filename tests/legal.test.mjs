import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./helpers.mjs";
import { CONTACT, LEGAL_FILES, NOT_AFFILIATED, PRIVACY, TERMS } from "../src/legal.mjs";

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const tracked = () => spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n").filter(Boolean);

test("the privacy page and the terms are exactly what the one source says (run `node scripts/build-legal.mjs`)", () => {
  for (const [f, text] of Object.entries(LEGAL_FILES())) assert.equal(read(f), text, f);
});

test("the privacy page covers what the tool reads, writes and can send, the dashboard, the website, GitHub, email, rights and who runs it", () => {
  const all = JSON.stringify(PRIVACY);
  for (const must of [/session logs/, /~\/\.sparelimit/, /sparelimit-handoff\.md/, /provider/, /sparelimit sync/, /update-pricing/, /127\.0\.0\.1/, /local storage/, /GitHub Pages/, /public/, /delete/, /Rotem Alt/]) assert.match(all, must);
  assert.ok(all.includes(CONTACT));
});

test("the terms cover the licence, no warranty, estimates, hooks that act, other people's data, affiliation and liability, and name no price", () => {
  const all = JSON.stringify(TERMS);
  for (const must of [/MIT licence/, /as is/, /not advice|financial, legal or professional advice/, /stop an action/, /other people's information/, /not affiliated/, /fullest extent the law allows/, /nothing to pay/]) assert.match(all, must);
  assert.doesNotMatch(all, /governing law|courts of/i, "no governing-law clause until a lawyer advises");
});

test("the notices ship with the code, with LiteLLM's copyright line, in the repository and in the package", () => {
  const n = read("THIRD_PARTY_NOTICES.md");
  assert.match(n, /Copyright \(c\) 2023 Berri AI/);
  assert.match(n, /shall be included in all copies or substantial portions/);
  const files = JSON.parse(read("package.json")).files;
  for (const f of ["THIRD_PARTY_NOTICES.md", "docs/PRIVACY.md", "docs/TERMS.md", "docs/RULES.md"]) assert.ok(files.includes(f), f);
});

test("the not-affiliated statement is in the README, on the product page and in the terms; the author is the licence holder", () => {
  assert.ok(read("README.md").includes(NOT_AFFILIATED));
  assert.ok(read("site", "index.html").includes(NOT_AFFILIATED));
  assert.equal(JSON.parse(read("package.json")).author, "Rotem Alt");
  assert.match(read("LICENSE"), /Copyright \(c\) 2026 Rotem Alt/);
});

test("the old name appears nowhere: not in a file, not in a file name", () => {
  const word = new RegExp("vi" + "be", "i");
  const hits = tracked().filter((f) => !f.startsWith("data/")).filter((f) => word.test(f) || word.test(read(f)));
  assert.deepEqual(hits, []);
});

test("every command the privacy page and the terms tell people to run exists, with those options", () => {
  const source = ["sparelimit.mjs", ...tracked().filter((f) => f.startsWith("src/cli/"))].map((f) => read(f)).join("\n");
  const commands = [...JSON.stringify([PRIVACY, TERMS]).matchAll(/`sparelimit ([a-z-]+)((?: [a-z-]+| --[a-z-]+)*)`/g)];
  assert.ok(commands.length >= 3);
  for (const [whole, cmd, rest] of commands) {
    assert.ok(source.includes(`"${cmd}"`), `${whole}: no command called ${cmd}`);
    for (const flag of rest.match(/--[a-z-]+/g) || []) assert.ok(source.includes(`"${flag}"`), `${whole}: no option ${flag}`);
  }
});
