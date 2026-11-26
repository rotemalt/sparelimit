// `npm run snapshot`: rewrites the author's published numbers (site/numbers.json) and the block on the product page from this machine's
// own ledger. The complaints line is kept as it is (edit it by hand). It sends nothing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NUMBERS_PATH, buildNumbers, renderNumbersHtml } from "../src/numbers.mjs";
import { readWeek } from "../src/week.mjs";
import { noLogsMessage } from "../src/emptystate.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const r = readWeek({ days: 0 });
if (!r) {
  console.error(noLogsMessage());
  process.exit(1);
}
const old = JSON.parse(fs.readFileSync(NUMBERS_PATH, "utf8"));
const next = { ...buildNumbers(r.week, new Date().toISOString().slice(0, 10)), complaints: old.complaints };
fs.writeFileSync(NUMBERS_PATH, JSON.stringify(next, null, 2) + "\n");
const page = path.join(root, "site", "index.html");
const re = /(<!-- numbers:start -->\n)[\s\S]*?(\n\s*<!-- numbers:end -->)/;
fs.writeFileSync(page, fs.readFileSync(page, "utf8").replace(re, (_m, a, b) => `${a}${renderNumbersHtml(next)}${b}`));
console.log(`Wrote the numbers of ${next.as_of} into site/numbers.json and site/index.html. Check them with: git diff`);
