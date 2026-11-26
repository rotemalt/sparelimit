// `npm run friday`: the numbers for the fixed Friday post, as facts and nothing else.
// 1. refreshes the numbers from this machine's own ledger (npm run snapshot), unless --no-write
// 2. runs the go-out check and reports how many things are open (on stderr: that is for you, not for the post)
// 3. prints the block (on stdout): the date, the counts, the breakdown, share-safe.
// It does not post, send or commit anything.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { breakdownEquation } from "../src/breakdown.mjs";
import { NUMBERS_PATH } from "../src/numbers.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const usd = (n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** The block, from the published numbers. Facts only: no prose, no times, no ids. Dates are days. */
export function fridayBlock(n) {
  const v = Object.fromEntries(n.items.map((i) => [i.id, i]));
  return [
    `Sparelimit, numbers of ${n.as_of}`,
    `Scope: ${n.scope}; rules version ${n.rules_version}`,
    `Alerts that fired: ${v.alerts.value} [${v.alerts.label}]`,
    `Where they went: ${breakdownEquation(n.breakdown)} [${n.breakdown.label}]`,
    `Acted on, of the alerts where it could be told: ${v["acted-on-rate"].value}% [${v["acted-on-rate"].label}]`,
    `Counted saving: ${usd(v["counted-saving"].value)} [${v["counted-saving"].label}], API-equivalent at list price`,
    `Predicted by the ignored alerts, not saved: ${usd(v["ignored-predicted"].value)} [${v["ignored-predicted"].label}]`,
    `Complaints received: ${n.complaints.value} [${n.complaints.label}], as of ${n.complaints.as_of}`,
    "Run it on your own logs: sparelimit week --days=0 --share"
  ].join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes("--no-write")) {
    const r = spawnSync(process.execPath, [path.join(root, "scripts", "snapshot.mjs")], { encoding: "utf8" });
    if (r.status !== 0) {
      console.error(`The numbers could not be refreshed: ${(r.stderr || r.stdout).trim()}`);
      process.exit(1);
    }
    console.error(r.stdout.trim());
  }
  const g = spawnSync(process.execPath, [path.join(root, "scripts", "go-out-check.mjs")], { encoding: "utf8" });
  const open = (g.stdout.match(/✖/g) || []).length;
  console.error(open ? `go-out-check: ${open} thing${open === 1 ? "" : "s"} open. Run npm run go-out-check to see which.` : "go-out-check: nothing open.");
  console.log(fridayBlock(JSON.parse(fs.readFileSync(NUMBERS_PATH, "utf8"))));
}
