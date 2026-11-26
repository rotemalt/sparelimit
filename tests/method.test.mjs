import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { METHOD, renderMethodHtml, renderMethodText } from "../src/method.mjs";
import { LEDGER } from "../src/ledger.mjs";
import { DELEGATION } from "../src/delegation.mjs";
import { COACH_DEFAULTS } from "../src/coach.mjs";
import { DEFAULT_POLICY } from "../src/policy.mjs";
import { REPLAY } from "../src/replay.mjs";
import { MIN_RESPONSES, HABITS } from "../src/adoption.mjs";
import { TIMELINE } from "../src/sessiontimeline.mjs";
import { ROOT, fixture, tempSparelimitHome } from "./helpers.mjs";

const sparelimitHome = tempSparelimitHome();
const html = renderMethodHtml();
const text = renderMethodText();

test("drift check: the committed site page is exactly what the code generates (run `node scripts/build-methodology.mjs` after changing a rule)", () => {
  assert.equal(fs.readFileSync(path.join(ROOT, "site", "methodology.html"), "utf8"), html);
});

test("the page quotes the thresholds the code actually applies, read from the code", () => {
  const has = (s) => assert.ok(text.includes(s), `missing: ${s}`);
  has(`slowed to ${Math.round(LEDGER.rateSlowdown * 100)}% or less of the previous ${LEDGER.rateMinutes} minutes`);
  has(`within ${LEDGER.restartWithinMin} minutes`);
  has(`within ${LEDGER.coldRestartWithinMin} minutes`);
  has(`shrank the conversation by ${Math.round((1 - LEDGER.resetDropRatio) * 100)}% or more`);
  has(`${DELEGATION.swarmConcurrent}+ running at once or ${DELEGATION.swarmAgents}+ in a session`);
  has(`at least ${Math.round(DELEGATION.materialShare * 100)}% of that session's spend`);
  has(`Context warning at ${DEFAULT_POLICY.context.warnPct}%, stop at ${DEFAULT_POLICY.context.blockPct}%`);
  has(`warn at $${DEFAULT_POLICY.budget.sessionWarnUSD} per session`);
  has(`stays quiet below $${COACH_DEFAULTS.resetMinSavingUSD.toFixed(2)}`);
  has(`${Math.round(REPLAY.rebuildTokens / 1000)}k tokens`);
  has(`at least ${MIN_RESPONSES} responses`);
  has(`${TIMELINE.errorFlood} or more tool calls that the tool reported as errors within ${TIMELINE.errorWindow} consecutive responses`);
  has(`pauses of ${TIMELINE.awayMinutes} minutes or more are shaded`);
  for (const [id, h] of Object.entries(HABITS)) { has(id); has(h.unit); }
});

test("every section has an id, a title and content; ids are unique and the contents list links to every one", () => {
  const ids = METHOD.sections.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of METHOD.sections) {
    assert.ok(s.title && s.blocks.length, s.id);
    assert.ok(html.includes(`id="${s.id}"`) && html.includes(`href="#${s.id}"`), s.id);
  }
});

test("the three labels, the ledger rule, and the honest limits are all on the page", () => {
  for (const w of ["exact", "derived", "estimated"]) assert.ok(html.includes(`<th scope="row">${w}</th>`), w);
  assert.match(text, /A saving is counted only when all three hold/);
  assert.match(text, /Counted savings can be negative/);
  assert.match(text, /Quality is not in a log/);
  assert.match(text, /CodeBurn was not reconciled/);
  assert.match(text, /not yet confirmed that ourselves on a real terminal session/, "the terminal status line is documented, not verified");
});

test("generated output is clean: no undefined or NaN, user-visible text is escaped, and the page loads no outside scripts or fonts", () => {
  for (const out of [html, text]) assert.doesNotMatch(out, /undefined|NaN|\[object/);
  const escaped = renderMethodHtml({ title: "A <b>&", lead: "x", sections: [{ id: "s", title: "T<script>", blocks: [{ p: "`<img src=x>` and **b**" }] }] });
  assert.doesNotMatch(escaped, /<img|<script>alert|<b>&/);
  assert.match(escaped, /<code>&lt;img src=x&gt;<\/code> and <b>b<\/b>/);
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!ccusage)/);
});

test("the methodology page is a plain file the landing page links to", () => {
  const page = fs.readFileSync(path.join(ROOT, "site", "methodology.html"), "utf8");
  assert.match(page, /How Sparelimit's numbers are computed/);
  assert.match(fs.readFileSync(path.join(ROOT, "site", "index.html"), "utf8"), /href="methodology\.html"/);
  assert.equal(fs.existsSync(path.join(ROOT, "site", "methodology.md")), false);
});

// ---- command and report footers
const home = () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-"));
  fs.mkdirSync(path.join(h, ".claude", "projects", "p"), { recursive: true });
  fs.copyFileSync(fixture("claude-code-session.jsonl"), path.join(h, ".claude", "projects", "p", "s.jsonl"));
  return h;
};
const sparelimit = (h, args) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { encoding: "utf8", env: { ...process.env, HOME: h, SPARELIMIT_HOME: sparelimitHome } });

test("sparelimit method prints the page, one section on request, and rejects an unknown section", () => {
  const h = home();
  assert.match(sparelimit(h, ["method"]).stdout, /THE THREE LABELS/);
  const one = sparelimit(h, ["method", "ledger"]).stdout;
  assert.match(one, /HOW A SAVING IS COUNTED/);
  assert.doesNotMatch(one, /THE THREE LABELS/);
  const bad = sparelimit(h, ["method", "nope"]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Sections: read-first, labels/);
});

test("every report points to the methodology", () => {
  const h = home();
  for (const cmd of [["replay", "--all"], ["coach"], ["delegate"], ["models"], ["track"], ["ledger"], ["digest", "--json"]]) {
    const out = sparelimit(h, cmd);
    assert.equal(out.status, 0, `${cmd.join(" ")}: ${out.stderr}`);
    if (!cmd.includes("--json")) assert.match(out.stdout, /sparelimit method/, cmd.join(" "));
  }
  // with something to count, the ledger points there too
  fs.writeFileSync(path.join(sparelimitHome, "audit.jsonl"), JSON.stringify({ t: new Date().toISOString(), kind: "finding", rule: "quota.projection", sessionId: "x" }) + "\n");
  assert.match(sparelimit(h, ["ledger"]).stdout, /sparelimit method/);
});

// ---- the landing page's claims
const landing = fs.readFileSync(path.join(ROOT, "site", "index.html"), "utf8");

test("landing page: every in-page link has a target, and it links to the methodology and privacy pages", () => {
  const ids = new Set([...landing.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  for (const [, target] of landing.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.has(target), `no element with id ${target}`);
  assert.match(landing, /href="methodology\.html"/);
  assert.match(landing, /href="privacy\.html"/);
});

test("landing page: claims that were wrong or stale are not back, and the labels match the methodology page", () => {
  assert.doesNotMatch(landing, /Stopping is off until you turn it on/, "stops are on by default at high thresholds once installed");
  assert.doesNotMatch(landing, /A savings report is next/, "the ledger is built");
  assert.doesNotMatch(landing, /Pro and Max sessions report their 5-hour and weekly usage, and Sparelimit records it\./, "that is documented for the terminal only, and not yet confirmed");
  assert.doesNotMatch(landing, /class="tag derived">measured/, "use the three labels: exact, derived, estimated");
  assert.match(landing, /ignored most of the alerts/, "the ledger's real state is stated, failures included (the page was rewritten on 2026-11-25; its numbers come from the card)");
  assert.match(landing, /one machine, one person/, "the page says whose numbers these are");
  assert.match(landing, /class="chip estimated">estimated/, "the counted saving carries its label");
});

test("landing page: no outside scripts, fonts or trackers", () => {
  assert.doesNotMatch(landing, /<script[^>]+src=|<link[^>]+href="https?:|googletagmanager|analytics|fonts\.googleapis/i);
});
