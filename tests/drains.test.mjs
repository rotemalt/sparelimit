import test from "node:test";
import assert from "node:assert/strict";
import { triggerOf, parseClaudeCode } from "../src/adapters/claude-code.mjs";
import { buildDrains } from "../src/drains.mjs";

test("what started a stretch of work is told from the text of the record that began it", () => {
  assert.equal(triggerOf("fix the parser", false), "typed");
  assert.equal(triggerOf("<task-notification>\n<task-id>x", false), "background-task");
  assert.equal(triggerOf("Stop hook feedback:\n[keep going]", true), "stop-hook");
  assert.equal(triggerOf("A session-scoped Stop hook is now active", true), "stop-hook");
  assert.equal(triggerOf("Continue from where you left off.", true), "continuation");
  assert.equal(triggerOf("This session is being continued from a previous conversation", false), "continuation");
  assert.equal(triggerOf("<command-name>/code-review</command-name>", false), "typed", "a slash command you type is work you asked for");
  assert.equal(triggerOf("<local-command-stdout>ok</local-command-stdout>", false), null);
  assert.equal(triggerOf("<system-reminder>\nthe session</system-reminder>", false), null);
  assert.equal(triggerOf("[Image: source: /tmp/a.png]", true), null, "a note about your own message starts nothing");
  assert.equal(triggerOf("Base directory for this skill: /x", true), null);
  assert.equal(triggerOf("some injected text", true), "other");
});

test("in a log, each response carries the trigger of the last record that began a turn; tool results do not change it", () => {
  const asst = (id, ts) => ({ type: "assistant", sessionId: "s", uuid: id, timestamp: ts, message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 1, output_tokens: 1 }, content: [] } });
  const user = (uuid, ts, content, extra = {}) => ({ type: "user", sessionId: "s", uuid, timestamp: ts, message: { content }, ...extra });
  const objs = [
    user("u1", "2026-11-07T10:00:00Z", "please fix it"), asst("a1", "2026-11-07T10:00:01Z"),
    user("u2", "2026-11-07T10:00:02Z", [{ type: "tool_result", tool_use_id: "t", content: "ok" }]), asst("a2", "2026-11-07T10:00:03Z"),
    user("u3", "2026-11-07T10:05:00Z", "Stop hook feedback:\n[keep going]", { isMeta: true }), asst("a3", "2026-11-07T10:05:01Z"),
    user("u4", "2026-11-07T10:06:00Z", "[Image: source: /tmp/x.png]", { isMeta: true }), asst("a4", "2026-11-07T10:06:01Z"),
    user("u5", "2026-11-07T10:10:00Z", "thanks, now the tests"), asst("a5", "2026-11-07T10:10:01Z")
  ];
  const s = parseClaudeCode("/x/s.jsonl", objs);
  assert.deepEqual(s.events.map((e) => e.trigger), ["typed", "typed", "stop-hook", "stop-hook", "typed"]);
});

test("the drain report lists unprompted spend by cause, biggest first, and says what it does not measure", () => {
  const d = buildDrains({ totalCostUSD: 1000, byTriggerUSD: { typed: { responses: 90, usd: 800, sessions: 3 }, "stop-hook": { responses: 10, usd: 150, sessions: 2 }, "background-task": { responses: 5, usd: 50, sessions: 1 }, continuation: { responses: 0, usd: 0, sessions: 0 } } });
  assert.deepEqual(d.rows.map((r) => [r.id, r.usd, r.shareOfSpend]), [["stop-hook", 150, 15], ["background-task", 50, 5]]);
  assert.equal(d.unpromptedUSD, 200);
  assert.equal(d.typedUSD, 800);
  assert.match(d.note, /idle-time compaction/);
  assert.deepEqual(buildDrains({}).rows, []);
});
