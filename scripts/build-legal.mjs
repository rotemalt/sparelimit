// Writes the privacy page and the terms (site and docs) from src/legal.mjs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LEGAL_FILES } from "../src/legal.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
for (const [f, text] of Object.entries(LEGAL_FILES())) {
  fs.writeFileSync(path.join(root, f), text);
  console.log(`Wrote ${f}`);
}
