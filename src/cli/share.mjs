/** `sparelimit safe-to-share <file>`: what to look for before a picture, a post or a page goes public. See src/safeshare.mjs. Reads one file; sends nothing. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IMAGE, scan, summarize } from "../safeshare.mjs";
import { replayAll } from "../transcripts.mjs";

/** The names that belong to this machine: user, computer and the folders of your projects. */
export function machineNames() {
  const names = [os.userInfo().username, os.hostname().split(".")[0], path.basename(os.homedir())];
  try {
    for (const r of replayAll()?.results || []) if (r.project) names.push(path.basename(String(r.project)));
  } catch { /* no logs: the other checks still run */ }
  return names;
}

/**
 * `--share`: check what was just produced with the same scanner as `sparelimit safe-to-share`, and say so on stderr (stdout stays the output
 * itself, so JSON stays JSON). Returns true when nothing was found. A clean result does not mean safe in every way: read it once.
 * @param {string} text
 * @param {string} what
 */
export function shareCheck(text, what) {
  const found = summarize(scan(text, { names: machineNames() }));
  if (!found.length) {
    console.error(`Share check: ${what} has no home path, email, session id, exact time, credential shape or name from this machine. Read it yourself once before it goes public.`);
    return true;
  }
  console.error(`Share check: ${what} is NOT clean:`);
  for (const f of found) console.error(`  ${String(f.n).padStart(3)} × ${f.kind}  (lines ${f.lines.join(", ")}${f.n > f.lines.length ? ", …" : ""}; e.g. ${f.sample})`);
  console.error("Do not post it. Nothing was changed.");
  process.exitCode = 1;
  return false;
}

/** @type {Record<string, (args: string[]) => Promise<void>>} */
export const commands = {
  "safe-to-share": async (args) => {
    const file = args.slice(1).find((a) => !a.startsWith("-"));
    if (!file || !fs.existsSync(file)) {
      console.error("Give a file: sparelimit safe-to-share output.txt   (a printed output, JSON, SVG, HTML or Markdown)");
      process.exit(1);
    }
    if (IMAGE.test(file)) {
      console.log(`${file} is an image or a PDF. I cannot read pixels, so this is NOT checked.\nCheck the output it was made from instead: save that as text and run \`sparelimit safe-to-share\` on it, then look at the picture once yourself.`);
      process.exit(3);
    }
    const found = summarize(scan(fs.readFileSync(file, "utf8"), { names: machineNames() }));
    if (args.includes("--json")) console.log(JSON.stringify({ file, clean: !found.length, found }, null, 2));
    else if (!found.length) console.log(`${file}: nothing found. No home path, email, session id, exact time, credential shape or name from this machine.\nThat does not make it safe in every way: read it yourself once before it goes public.`);
    else {
      console.log(`${file}: NOT clean. Found:`);
      for (const f of found) console.log(`  ${String(f.n).padStart(3)} × ${f.kind}  (lines ${f.lines.join(", ")}${f.n > f.lines.length ? ", …" : ""}; e.g. ${f.sample})`);
      console.log("\nRemove or cover these, then run it again. Nothing was changed.");
    }
    process.exit(found.length ? 1 : 0);
  }
};
