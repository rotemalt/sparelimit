// Regenerates site/methodology.html from src/method.mjs. A test fails if the committed page is out of date.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderMethodHtml } from "../src/method.mjs";

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "site", "methodology.html");
fs.writeFileSync(out, renderMethodHtml());
console.log(`wrote ${out}`);
