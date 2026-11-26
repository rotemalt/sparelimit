import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderNumbersHtml } from "../src/numbers.mjs";
import { ROOT } from "./helpers.mjs";

const card = JSON.parse(fs.readFileSync(path.join(ROOT, "site", "numbers.json"), "utf8"));
const page = () => fs.readFileSync(path.join(ROOT, "site", "index.html"), "utf8");

test("the numbers on the product page are the published numbers: same rows, nothing typed twice", () => {
  const block = page().match(/<!-- numbers:start -->\n([\s\S]*?)\n\s*<!-- numbers:end -->/)?.[1];
  assert.equal(block, renderNumbersHtml(card), "run: npm run snapshot");
  const v = Object.fromEntries(card.items.map((i) => [i.id, i.value]));
  assert.match(page(), new RegExp(`data-n="alerts">${v.alerts}<`));
  assert.match(page(), new RegExp(`data-n="counted-saving">\\$${v["counted-saving"].toFixed(2)}<`));
  assert.match(page(), /class="chip estimated">estimated/, "the counted saving shows its label");
  for (const f of card.notCounted) assert.match(page(), new RegExp(`data-n="not-${f.id}">${f.n}<`), "what was not counted is on the page");
});

test("the page offers nothing to pay for, shows no old plans, no testimonials and loads nothing from outside", () => {
  const html = page();
  assert.doesNotMatch(html, /5%|charg|pricing|subscribe/i);
  assert.match(html, /nothing to pay/);
  assert.match(html, /nothing leaves your computer/i);
  assert.doesNotMatch(html, /\$79|\$99|\$20|per seat|Individual|Team and agency|early access/i, "the old plans and prices are gone");
  assert.doesNotMatch(html, /testimonial|trusted by|users love|rated/i);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|@import|fonts\.googleapis/i, "nothing is loaded from outside");
  assert.match(html, /name="viewport"/);
});

test("the site is static: no form, no PHP, no server code, no script that sends anything", () => {
  const html = page();
  assert.doesNotMatch(html, /<form|<input|type="email"|fetch\(|XMLHttpRequest|api\/waitlist|Email me/i, "no form and no request from the page");
  assert.deepEqual(fs.readdirSync(path.join(ROOT, "site")).sort(), ["index.html", "methodology.html", "numbers.json", "privacy.html", "terms.html"], "the site folder holds four plain files");
  for (const f of ["site/api", "site/server.mjs", "site/app.mjs", "site/_data", "site/.htaccess"]) assert.equal(fs.existsSync(path.join(ROOT, f)), false, `${f} is gone`);
  for (const f of ["index.html", "privacy.html", "methodology.html"]) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "site", f), "utf8"), /<form|\.php|set-cookie|document\.cookie/i, f);
});

test("the page says how to follow along: releases and discussions, no mailing list, and no X link with a placeholder", () => {
  const html = page();
  assert.match(html, /href="https:\/\/github\.com\/rotemalt\/sparelimit\/releases">Watch releases on GitHub</);
  assert.match(html, /href="https:\/\/github\.com\/rotemalt\/sparelimit\/discussions">Discussions</);
  assert.doesNotMatch(html, /YOUR-X-HANDLE/);                  // the X line is added back when the profile exists
  assert.match(html, /There is no mailing list/);
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /## Follow along/);
  assert.match(readme, /\/releases\)/);
  assert.match(readme, /\/discussions\)/);
  assert.doesNotMatch(readme, /YOUR-X-HANDLE/);
});


test("every link inside the site is relative, so it works under a project address like user.github.io/sparelimit/", () => {
  for (const f of ["index.html", "privacy.html", "terms.html", "methodology.html"]) {
    const html = fs.readFileSync(path.join(ROOT, "site", f), "utf8");
    assert.doesNotMatch(html, /(?:href|src)="\/(?!\/)/, `${f} has a root-absolute link`);
  }
});
