#!/usr/bin/env node
// Type check (A11): TypeScript's checker over the JavaScript, with `strict` on (strictNullChecks, noImplicitAny and the rest). The runtime
// has no dependencies; this is a dev tool.
//   npm install --no-save typescript@5.6.3 @types/node@22 && npm run typecheck
// The count must not go above scripts/typecheck-baseline.json ({ "errors": 0 }): it was a ratchet while the code was being typed, and it is
// at zero now, so any new error fails.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsc = process.env.TSC_BIN || path.join(root, "node_modules", ".bin", "tsc");
if (!fs.existsSync(tsc)) {
  console.error("TypeScript is not installed. Run: npm install --no-save typescript@5.6.3 @types/node@22");
  process.exit(2);
}
const baseline = JSON.parse(fs.readFileSync(path.join(root, "scripts", "typecheck-baseline.json"), "utf8"));
const r = spawnSync(tsc, ["-p", path.join(root, "tsconfig.json")], { encoding: "utf8", cwd: root });
const out = `${r.stdout || ""}${r.stderr || ""}`;
const n = (out.match(/error TS\d+/g) || []).length;
if (n > baseline.errors) {
  console.error(out.split("\n").filter((l) => l.includes("error TS")).slice(0, 40).join("\n"));
  console.error(`\nType check (tsconfig.json, strict): ${n} errors, up from the baseline of ${baseline.errors}. Fix the new ones.`);
  process.exit(1);
}
console.log(`Type check (tsconfig.json, strict): ${n} errors (baseline ${baseline.errors})${n < baseline.errors ? `. Lower "errors" in scripts/typecheck-baseline.json to lock the gain in.` : "."}`);
