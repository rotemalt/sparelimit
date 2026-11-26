#!/usr/bin/env node
// Run before making the repository public:  npm run go-out-check
// It fails (exit 1) while anything that must be true on the day is not yet true. It reads files and runs git; it sends nothing.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NUMBERS_PATH, renderNumbersHtml, validateNumbers } from "../src/numbers.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ f) => fs.readFileSync(path.join(root, f), "utf8");
const git = (/** @type {string[]} */ ...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" }).stdout.trim();
/** @type {{ ok: boolean, what: string, fix?: string }[]} */
const results = [];
const check = (/** @type {boolean} */ ok, /** @type {string} */ what, /** @type {string} */ fix = "") => results.push({ ok, what, fix });

const numbers = JSON.parse(fs.readFileSync(NUMBERS_PATH, "utf8"));
const page = read("site/index.html");
const ageDays = Math.floor((Date.now() - Date.parse(`${numbers.as_of}T00:00:00Z`)) / 86400e3);

for (const f of ["site/privacy.html", "site/terms.html"]) check(/mailto:[^"@\s]+@[^"\s]+\.[a-z]+"/.test(read(f)), `${f} has a contact address`);
check(ageDays <= 2, `The published numbers are fresh (${numbers.as_of}, ${ageDays} days old)`, "Run: npm run snapshot");
check(page.match(/<!-- numbers:start -->\n([\s\S]*?)\n\s*<!-- numbers:end -->/)?.[1] === renderNumbersHtml(numbers), "The numbers on the page are the numbers in site/numbers.json", "Run: npm run snapshot");
check(validateNumbers(numbers).length === 0, "The published numbers are well formed", validateNumbers(numbers).join("; "));
check(!/CONTACT-ADDRESS-NOT-SET|YOUR-X-HANDLE|\[open/.test(page + read("README.md")), "No placeholder is left in the page or the README");
check(!fs.existsSync(path.join(root, "site/api")) && !fs.readdirSync(path.join(root, "site")).some((f) => f.endsWith(".php")), "The site is static: no PHP and no server code in site/");
check(fs.existsSync(path.join(root, "THIRD_PARTY_NOTICES.md")), "Third-party notices are included");
check(git("status", "--porcelain") === "", "Everything is committed (a public repository shows only what is committed)", "Review `git status`, then commit what you want public");

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "✔" : "✖"} ${r.what}${r.ok || !r.fix ? "" : `\n    → ${r.fix}`}`);
}
console.log(failed ? `\n${failed} thing${failed === 1 ? "" : "s"} to do before going out.` : "\nReady. The steps for the day are in your private go-out checklist.");
process.exit(failed ? 1 : 0);
