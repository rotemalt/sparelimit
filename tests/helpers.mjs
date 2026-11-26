import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const fixture = (name) => path.join(ROOT, "tests", "fixtures", name);

/** Point all sparelimit state at a fresh temp dir for the duration of a test file. */
export function tempSparelimitHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-test-"));
  process.env.SPARELIMIT_HOME = dir;
  process.env.SPARELIMIT_NO_NOTIFY = "1"; // never pop a real desktop notification from tests
  process.env.SPARELIMIT_NO_REFRESH = "1"; // never start the background plan-cache refresher from tests
  return dir;
}
