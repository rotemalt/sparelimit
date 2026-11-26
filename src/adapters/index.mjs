import fs from "node:fs";
import path from "node:path";
import { looksLikeClaudeCode, parseClaudeCode } from "./claude-code.mjs";
import { looksLikeAntigravity, parseAntigravity } from "./antigravity.mjs";
import { looksLikeCodex, parseCodex } from "./codex.mjs";
import { looksLikeGemini, parseGemini } from "./gemini.mjs";

export function readJsonl(/** @type {string} */ filePath) {
  const out = [];
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}

/** Parse any supported transcript into the normalized Session, or return null if no adapter recognises it. */
export function parseTranscript(/** @type {string} */ filePath) {
  let objs = readJsonl(filePath);
  // Gemini CLI's older sessions are one JSON document, not lines
  if (String(filePath).endsWith(".json")) {
    try {
      objs = [JSON.parse(fs.readFileSync(filePath, "utf8"))];
    } catch {}
  }
  if (looksLikeClaudeCode(objs)) {
    // Subagents (Task tool, /btw, ...) log to <session>/subagents/*.jsonl. They are real, billed API calls:
    // read them as sidechain events so spend and fan-out are not silently missing.
    const dir = path.join(path.dirname(filePath), path.basename(filePath, ".jsonl"), "subagents");
    const extra = [];
    let subagentFiles = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        subagentFiles += 1;
        // Who this side thread is: the file name is the agent id; the .meta.json beside it says what kind it is and which Task call started it.
        /** @type {any} */
        let meta = {};
        try {
          meta = JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.jsonl$/, ".meta.json")), "utf8"));
        } catch {}
        const agent = { agentId: f.replace(/\.jsonl$/, ""), agentType: meta.agentType || null, agentToolUseId: meta.toolUseId || null };
        for (const o of readJsonl(path.join(dir, f))) extra.push({ ...o, isSidechain: true, ...agent });
      }
    } catch {}
    const session = parseClaudeCode(filePath, objs.concat(extra));
    /** @type {any} */ (session.raw).subagentFiles = subagentFiles;
    return session;
  }
  if (looksLikeCodex(objs)) return parseCodex(filePath, objs);
  if (looksLikeAntigravity(objs)) return parseAntigravity(filePath, objs);
  if (looksLikeGemini(objs)) return parseGemini(filePath, objs);
  return null;
}
