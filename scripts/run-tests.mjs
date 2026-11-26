#!/usr/bin/env node
// Runs every tests/*.test.mjs with the built-in test runner. The file list is built here instead of passing a glob to `node --test`,
// because Node 20 does not expand globs (Node 21 and later do), and CI runs Node 20, 22 and 24.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = fs.readdirSync(path.join(root, "tests")).filter((f) => f.endsWith(".test.mjs")).sort().map((f) => path.join("tests", f));
const r = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], { cwd: root, stdio: "inherit" });
process.exit(r.status ?? 1);
