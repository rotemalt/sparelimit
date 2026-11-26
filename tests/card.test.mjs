import test from "node:test";
import assert from "node:assert/strict";
import { buildCard, renderCardSvg, renderCardHtml } from "../src/card.mjs";

const habits = {
  sessions: 12,
  weeks: 3.5,
  totalUSD: 1234.56,
  savings: [
    { title: 'Start fresh at ~60% of the window <script>alert("x")</script> & more', usd: 200, shareOfSpend: 16.2, confidence: "estimated", kind: "saving" },
    { title: "Tiny thing", usd: 1, shareOfSpend: 0.1, confidence: "estimated", kind: "saving" }
  ],
  atStake: [{ title: "Side threads (subagents)", usd: 300, shareOfSpend: 24.3, confidence: "derived", kind: "at-stake" }]
};
const spend = { cacheReadUSD: 600, cacheWriteUSD: 300, outputUSD: 100, inputUSD: 0, startContextUSD: 90 };
const card = (o = {}) => buildCard({ habits, spend, date: "2026-11-06T10:00:00Z", ...o });

test("the card holds shares that add to 100, the largest changes first, and drops anything under 1% of spend", () => {
  const c = card();
  assert.deepEqual(c.split.map((s) => [s.key, s.pct]), [["resend", 60], ["fresh", 30], ["write", 10]]);
  assert.equal(c.split.reduce((n, s) => n + s.pct, 0), 100);
  assert.deepEqual(c.changes.map((h) => [h.sharePct, h.kind, h.confidence]), [[24, "at stake", "derived"], [16, "could save", "estimated"]]);
  assert.equal(c.totalUSD, 1235);
  assert.equal(c.startContextPct, 9);
  assert.equal(c.date, "2026-11-06");
});

test("--hide-dollars leaves every dollar amount out of the data, the image and the page", () => {
  const c = card({ hideDollars: true });
  assert.equal(c.totalUSD, null);
  for (const out of [renderCardSvg(c), renderCardHtml(c)]) assert.doesNotMatch(out, /\$\d/);
  assert.match(renderCardSvg(card()), /\$1,235 over 12 sessions/);
});

test("text is escaped, so a title cannot inject markup; no paths or prompts are in the output; the image is well formed", () => {
  const svg = renderCardSvg(card());
  assert.doesNotMatch(svg, /<script/);
  assert.match(svg, /&lt;script&gt;/);
  assert.doesNotMatch(svg + renderCardHtml(card()), /\/Users\/|\.jsonl/);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1200 630"/);
  assert.equal((svg.match(/<svg/g) || []).length, 1);
  assert.ok(svg.trimEnd().endsWith("</svg>"));
  assert.match(renderCardHtml(card()), /^<!doctype html>/);
});

test("long titles are cut at a word, and a session with nothing large to change still renders", () => {
  const long = card({ habits: { ...habits, savings: [{ title: "word ".repeat(30), usd: 500, shareOfSpend: 30, confidence: "estimated", kind: "saving" }], atStake: [] } });
  assert.ok(long.changes[0].title.endsWith("..."));
  assert.doesNotMatch(long.changes[0].title, /\s\.\.\.$/);
  const none = card({ habits: { ...habits, savings: [], atStake: [] } });
  assert.deepEqual(none.changes, []);
  assert.match(renderCardSvg(none), /WHAT TO CHANGE/);
});
