// Writes docs/RULES.md from the code, and (with --lock) adds the current version to docs/rules-lock.json when it is not there yet.
// An entry for an existing version is never rewritten. Run it after you raise LEDGER_RULES_VERSION.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderRulesMd, rulesHash, rulesSnapshot } from "../src/rules.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
fs.writeFileSync(path.join(root, "docs", "RULES.md"), renderRulesMd());
console.log("Wrote docs/RULES.md");
if (process.argv.includes("--lock")) {
  const file = path.join(root, "docs", "rules-lock.json");
  const lock = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { note: "One entry per rules version. An entry is never edited after it is added; a new version gets a new entry.", versions: {} };
  const snap = rulesSnapshot();
  if (lock.versions[snap.version]) {
    const same = lock.versions[snap.version].sha256 === rulesHash(snap);
    console.log(same ? `Version ${snap.version} is already in the lock and matches.` : `Version ${snap.version} is already in the lock and the rules DO NOT match it. Raise LEDGER_RULES_VERSION; do not edit the old entry.`);
    process.exit(same ? 0 : 1);
  }
  lock.versions[snap.version] = { sha256: rulesHash(snap), frozen: new Date().toISOString().slice(0, 10), thresholds: snap.thresholds, families: snap.families };
  fs.writeFileSync(file, JSON.stringify(lock, null, 2) + "\n");
  console.log(`Added version ${snap.version} to docs/rules-lock.json`);
}
