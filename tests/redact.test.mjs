import test from "node:test";
import assert from "node:assert/strict";
import { redactReport, HIDDEN_GOAL } from "../src/redact.mjs";

const full = () => ({
  sessionId: "s1",
  transcriptPath: "/Users/dana/.claude/projects/-Users-dana-App/abc.jsonl",
  userTurns: [{ stepIndex: 0, text: "my secret plan: use key sk-123", createdAt: "2026-11-06T08:00:00Z" }],
  failedCommands: [{ command: "curl -H 'Authorization: Bearer abc' https://x", summary: "401 Unauthorized abc" }],
  touchedFiles: [{ file: "/Users/dana/App/src/a.js", basename: "a.js", reads: 2, writes: 1 }, { file: "/opt/x.js", basename: "x.js", reads: 1, writes: 0 }],
  reReadFiles: [{ file: "/Users/dana/App/src/a.js", basename: "a.js", reads: 2, writes: 1 }],
  handoffPrompt: 'Continue task in a.js:\n- Goal from previous session: "my secret plan: use key sk-123"',
  handoffPromptHidden: `Continue task in a.js:\n- Goal from previous session: ${HIDDEN_GOAL}`,
  realCostUSD: 3.2
});

test("by default no prompt text, no command arguments and no home folder leave the process", () => {
  const out = redactReport(full(), { show: false, home: "/Users/dana" });
  const s = JSON.stringify(out);
  assert.doesNotMatch(s, /secret plan|sk-123|Bearer|Unauthorized|\/Users\/dana/);
  assert.deepEqual(out.userTurns, [{ stepIndex: 0, createdAt: "2026-11-06T08:00:00Z", chars: 30 }]);
  assert.deepEqual(out.failedCommands, [{ command: "curl" }]);
  assert.equal(out.transcriptPath, "abc.jsonl");
  assert.deepEqual(out.touchedFiles.map((f) => f.file), ["~/App/src/a.js", "/opt/x.js"]);
  assert.match(out.handoffPrompt, /hidden/);
  assert.equal(out.handoffPromptHidden, undefined);
  assert.equal(out.redacted, true);
  assert.equal(out.realCostUSD, 3.2, "numbers are untouched");
});

test("SPARELIMIT_SHOW_PROMPTS=1 (show) keeps the text; the original report is never changed; an empty report passes through", () => {
  const r = full();
  const shown = redactReport(r, { show: true });
  assert.match(shown.handoffPrompt, /secret plan/);
  assert.equal(shown.userTurns[0].text, "my secret plan: use key sk-123");
  redactReport(r, { show: false });
  assert.equal(r.userTurns[0].text, "my secret plan: use key sk-123");
  assert.deepEqual(redactReport({}), {});
  assert.equal(redactReport(null), null);
});
