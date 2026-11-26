import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./helpers.mjs";
import { scan } from "../src/safeshare.mjs";

const text = fs.readFileSync(path.join(ROOT, "docs", "FINDING.md"), "utf8");
const rows = text.split("\n").filter((l) => /^\| .+ \| .+ \| .+ \| `.+` \|$/.test(l) && !l.startsWith("| Finding") && !l.startsWith("| :"));

test("the finding is dated, says what it is a sample of, and every number has a label and a command that exists", () => {
  assert.match(text, /Read on 2026-\d{2}-\d{2}/);
  assert.match(text, /one machine, one person/);
  assert.ok(rows.length >= 6);
  const commands = fs.readFileSync(path.join(ROOT, "src", "cli", "analysis.mjs"), "utf8");
  for (const r of rows) {
    const cells = r.split("|").map((c) => c.trim()).filter(Boolean);
    assert.match(cells[2], /^(\*\*)?(exact|derived|estimated)(\*\*)?$/, r);
    const cmd = cells[3].replace(/`/g, "").split(" ")[1];
    assert.ok(commands.includes(`"${cmd}"`), `sparelimit ${cmd} exists`);
  }
});

test("the estimated figures are labelled estimated, and the weak points are written down", () => {
  for (const r of rows.filter((x) => /saving if/i.test(x))) assert.match(r, /estimated/);
  assert.match(text, /## What is weak/);
  assert.match(text, /List price is not what was billed/);
  assert.match(text, /must not be added/);
});

test("the finding has nothing a scanner would stop: no path, email, session id, exact time or name from this machine", () => {
  assert.deepEqual(scan(text, { names: [os.userInfo().username, os.hostname().split(".")[0]] }), []);
});

test("the replay figures are the same in the finding, the README and the product page: one run, one date, no two that disagree", () => {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const page = fs.readFileSync(path.join(ROOT, "site", "index.html"), "utf8");
  const [, sessions] = text.match(/from (\d+) Claude Code sessions/);
  const [, date] = text.match(/Read on (\d{4}-\d{2}-\d{2})/);
  const total = rows.find((r) => /Total spend/.test(r)).match(/\$[\d,]+\.\d{2}/)[0];
  const resent = rows.find((r) => /re-sending the conversation/.test(r)).match(/(\d+%) \((\$[\d,.]+)\)/);
  const model = rows.find((r) => /reset at 60%/.test(r)).match(/about (\d+%) of spend \(range (\$[\d,.]+) to (\$[\d,.]+)\)/);
  const cold = rows.find((r) => /after the cache had gone cold/.test(r)).match(/(\d+) times, (\$[\d,.]+) more/);
  for (const v of [`${sessions} Claude Code sessions`, `read on ${date}`, total, `${resent[1]} (${resent[2]})`, `about ${model[1]} of spend (range ${model[2]} to ${model[3]})`, `${cold[1]} times, ${cold[2]} more`]) assert.ok(readme.includes(v), `README: ${v}`);
  assert.ok(page.includes(`from ${sessions} sessions read on ${date}`), "page: sample and date");
  assert.ok(page.includes(`<td class="num">${resent[1]}</td>`), "page: re-sent share");
  assert.ok(page.includes(`<td class="num">about ${model[1]}</td>`), "page: modelled saving");
  assert.ok(readme.includes(`for example about ${model[1]} if every long session`), "the statement of what Sparelimit does not claim uses the same figure");
});

test("the product page says what it is a sample of once, and the complaint line holds whether or not the repository is public", () => {
  const page = fs.readFileSync(path.join(ROOT, "site", "index.html"), "utf8");
  const numbers = page.split('<section id="numbers">')[1].split("<!-- numbers:end -->")[0];
  assert.equal(numbers.match(/one machine, one person/gi).length, 1);
  assert.doesNotMatch(numbers, /From the author's own machine|the repository was private on this date, so there were none/);
  assert.match(numbers, /counted before the repository was public/);
  assert.match(page, /I ignored most of the alerts[\s\S]{0,400}<code>sparelimit act<\/code>[\s\S]{0,300}I have not measured whether it changes how often I act/);
});
