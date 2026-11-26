// `npm run release-files`: builds the three files a release carries, into build/release/ (ignored by git). It uploads nothing.
//   sparelimit-<version>.tgz   the installer (npm pack of this folder)
//   count-opted-in       one byte
//   count-saving         one byte
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const out = path.resolve(process.argv[2] || path.join(root, "build", "release"));
fs.mkdirSync(out, { recursive: true });
const r = spawnSync("npm", ["pack", "--json", "--pack-destination", out], { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
if (r.status !== 0) {
  console.error(r.stderr);
  process.exit(1);
}
const [packed] = JSON.parse(r.stdout);
const name = `sparelimit-${version}.tgz`;
fs.renameSync(path.join(out, packed.filename), path.join(out, name));
for (const f of ["count-opted-in", "count-saving"]) fs.writeFileSync(path.join(out, f), "x");
console.log(`Built in ${out}:\n  ${name}  (${fs.statSync(path.join(out, name)).size} bytes, ${packed.files.length} files)\n  count-opted-in  (1 byte)\n  count-saving  (1 byte)\nUpload these three to the release v${version}. Nothing was uploaded.`);
