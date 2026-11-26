/** The commands that read your history: replay, coach, digest, ledger, timeline and the rest. Split out of sparelimit.mjs (A11). */
import { shareCheck } from "./share.mjs";
import { afterReport } from "../count.mjs";
import { shareDay, shareLedger, shareWeek } from "../shareview.mjs";
import { breakdownEquation, breakdownFromTotals } from "../breakdown.mjs";
import { noLogsMessage } from "../emptystate.mjs";
import fs from "node:fs";
import path from "node:path";
import { HABITS, buildAdoption, clearMarker, readMarkers, setMarker } from "../adoption.mjs";
import { METHOD, renderMethodText } from "../method.mjs";
import { METHOD_FOOTER } from "../constants.mjs";
import { REBUILD, rebuildEvents, summarizeRebuild } from "../rebuild.mjs";
import { auditPath } from "../state.mjs";
import { buildCard, renderCardHtml, renderCardSvg } from "../card.mjs";
import { buildHabitCard } from "../habits.mjs";
import { buildLedger } from "../ledger.mjs";
import { SUMMARY_DAYS, readWeek, renderWeekText } from "../week.mjs";
import { clearDigestLock, writeDigest } from "../digestcache.mjs";
import { isClaudeLog } from "../sources.mjs";

import { computeDigest, computeHabitCard, discoverTranscripts, listClaudeSessions, readAuditRows, replayAll, timelineFor } from "../transcripts.mjs";
import { fitLimits, loadCalibration } from "../planestimate.mjs";
import { parseTranscript } from "../adapters/index.mjs";
import { replaySession, summarize } from "../replay.mjs";

/** @type {Record<string, (args: string[]) => Promise<void>>} one handler per command; `args` is the whole command line after `sparelimit`, args[0] being the command */
export const commands = {
  "replay": async (args) => {
    const json = args.includes("--json");
    const all = args.includes("--all");
    const top = Number(args.find((a) => a.startsWith("--top="))?.slice(6)) || 8;
    const file = args.slice(1).find((a) => !a.startsWith("-"));
    const targets = file ? [{ filePath: path.resolve(file) }] : all ? discoverTranscripts(null, { global: true }).filter((t) => isClaudeLog(t.filePath)) : discoverTranscripts(null).slice(0, 1);
    if (!targets.length) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    let results = [];
    if (all && !file) {
      // all sessions: the cached per-session results (without the per-response timeline, which this view does not show)
      results = (replayAll()?.results || []).map(({ timeline, ...r }) => r);
    } else {
      for (const t of targets) {
        const session = parseTranscript(t.filePath);
        const r = session && replaySession(session);
        if (r) results.push(r);
      }
    }
    const summary = summarize(results);
    if (json) {
      console.log(JSON.stringify({ summary, sessions: results }, null, 2));
      return;
    }
    const usd = (/** @type {number} */ n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    console.log(`\n⚡ SPARELIMIT REPLAY: what the guard would have said on your past sessions`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`${summary.sessions} sessions · ${usd(summary.totalCostUSD)} at list price [derived]`);
    console.log(`${summary.sessionsWithWarning} would have got a warning · ${summary.sessionsWithStop} would have been stopped`);
    console.log(`Spent after the first stop:      ${usd(summary.spendAfterFirstStopUSD)} [derived: money spent later in those sessions, not savings]`);
    console.log(`  of which stuck repeats:        ${usd(summary.avoidableRepeatedCallsUSD)} [derived: same call, same result, 8+ times]`);
    /** @type {any} */
    const sb = summary.spendBreakdownUSD;
    const share = (/** @type {any} */ x) => `${((x / summary.totalCostUSD) * 100).toFixed(0)}%`;
    console.log(`\nWHERE THE SPEND GOES [derived from your logs, list price]`);
    console.log(`  re-sending the conversation on every message: ${usd(sb.cacheReadUSD)} (${share(sb.cacheReadUSD)})`);
    console.log(`    of which your fixed starting context:        ${usd(sb.startContextUSD)} (${share(sb.startContextUSD)})  (system prompt, tools, memory)`);
    console.log(`  adding new content to the conversation:        ${usd(sb.cacheWriteUSD)} (${share(sb.cacheWriteUSD)})`);
    console.log(`  what the AI writes:                            ${usd(sb.outputUSD)} (${share(sb.outputUSD)})`);
    const carry = Object.entries(summary.toolOutputCarryUSD).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ${usd(v)} (${share(v)})`).join(" · ");
    console.log(`  cost of keeping tool output in context:        ${carry} [estimated]`);
    console.log(`  file reads: ${summary.reads.total}; reading the same unchanged file again: ${summary.reads.identicalRepeats} times (${((summary.reads.identicalRepeats / Math.max(1, summary.reads.total)) * 100).toFixed(0)}% of reads), costing ${usd(summary.reads.identicalRepeatsCarryUSD)} = ${((summary.reads.identicalRepeatsCarryUSD / summary.totalCostUSD) * 100).toFixed(1)}% of spend [estimated]`);
    const er = summary.earlierReset;
    const br = summary.breaks;
    console.log(`\nBREAKS: ${br.messages} times you came back to a big conversation after the cache had gone cold (${br.over60min} after more than an hour)`);
    console.log(`  re-processing the whole conversation cost ${usd(br.resumeUSD)} (${usd(br.extraVsWarmUSD)} more than a warm cache would have) [derived]`);
    console.log(`  a fresh start with a short handoff would have saved about ${usd(br.savingUSD)} = ${((br.savingUSD / summary.totalCostUSD) * 100).toFixed(1)}% of spend [estimated: assumes a 4k handoff and 25k tokens re-read]`);
    console.log(`\nIF YOU HAD RESET AT 60% INSTEAD OF WAITING FOR AUTO-COMPACTION [estimated, ${er.sessionsModelled} long sessions]`);
    console.log(`  modelled saving: ${usd(er.netSavingUSD)} = ${((er.netSavingUSD / summary.totalCostUSD) * 100).toFixed(0)}% of total spend (range ${usd(er.netSavingLowUSD)} to ${usd(er.netSavingHighUSD)}, depending on how much has to be re-read after each reset)`);
    console.log(`\nRules that fired: ${Object.entries(summary.byRule).map(([k, v]) => `${k} ×${v}`).join(", ") || "none"}`);
    console.log(`Dollar budgets are not replayed (arbitrary for long sessions). Quota rules need live data. Estimates assume you would have acted on the stop.`);
    console.log(METHOD_FOOTER);
    const rank = [...results].sort((a, b) => b.exposure.afterFirstStopUSD - a.exposure.afterFirstStopUSD).filter((r) => r.firstWarn).slice(0, file ? 1 : top);
    for (const r of rank) {
      console.log(`\n${r.sessionId.slice(0, 8)}…  ${r.durationMin} active min over ${r.spanDays} days · ${usd(r.totalCostUSD)} · ${r.responses} responses`);
      for (const f of r.findings.slice(0, file ? 20 : 4)) console.log(`  +${String(f.minute).padStart(4)} active min  ${f.level.toUpperCase().padEnd(5)} ${f.rule}  (spent so far ${usd(f.costSoFarUSD)})\n             ${f.message}`);
      if (r.firstBlock) console.log(`  After the first stop: ${r.exposure.afterFirstStopMinutes} more active min and ${usd(r.exposure.afterFirstStopUSD)} more [derived]`);
    }
    console.log("");
    if (results.length) await afterReport({ entries: [], ran: true });
    return;
  },
  "coach": async (args) => {
    const json = args.includes("--json");
    const card = computeHabitCard();
    if (!card) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    if (json) {
      console.log(JSON.stringify(card, null, 2));
      return;
    }
    const usd = (/** @type {number} */ n) => `$${Math.round(n).toLocaleString("en-US")}`;
    const pad = (/** @type {any} */ s, /** @type {number} */ n) => String(s).padEnd(n);
    const line = (/** @type {any} */ h, /** @type {any} */ i) => {
      const facts = [h.range && `range ${usd(h.range[0])}–${usd(h.range[1])}`, h.weeklyLimitPct != null && `≈${h.weeklyLimitPct}% of a weekly limit in an average week`].filter(Boolean).join(" · ");
      console.log(`${i}. ${pad(usd(h.usd), 6)} ${pad(h.shareOfSpend.toFixed(1) + "%", 6)} ${h.title}  [${h.confidence}]`);
      if (facts) console.log(`          ${facts}`);
      console.log(`          How: ${h.how}`);
      if (h.caution) console.log(`          Caution: ${h.caution}`);
    };
    console.log(`\n⚡ SPARELIMIT COACH: what to change, ranked by what it costs you`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`${card.sessions} sessions over ${card.weeks} weeks · ${usd(card.totalUSD)} at list price [derived]\n`);
    console.log(`MODELLED SAVINGS (each assumes you make the change; they overlap, so do not add them up)`);
    card.savings.forEach((h, i) => line(h, i + 1));
    console.log(`\nWHERE ELSE THE SPEND IS (spend in the area, not a saving: the most a habit could touch)`);
    card.atStake.forEach((h, i) => line(h, i + 1));
    console.log(`\n${card.note}\n${METHOD_FOOTER}\n`);
    return;
  },
  "delegate": async (args) => {
    const all = replayAll();
    if (!all) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    const d = all.summary.delegation;
    const withAgents = all.results.filter((r) => r.delegation.agents).sort((a, b) => b.delegation.sideUSD - a.delegation.sideUSD);
    if (args.includes("--json")) {
      console.log(JSON.stringify({ summary: d, sessions: withAgents.map((r) => ({ sessionId: r.sessionId, totalCostUSD: r.totalCostUSD, ...r.delegation })) }, null, 2));
      return;
    }
    const usd = (/** @type {number} */ n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const pct = (/** @type {number} */ n) => `${(n * 100).toFixed(0)}%`;
    console.log(`\n⚡ SPARELIMIT DELEGATION: when subagents pay, and when a swarm does not`);
    console.log(`──────────────────────────────────────────────────────────────`);
    if (!d.agents) {
      console.log(`No subagents found in ${all.summary.sessions} sessions.\n${METHOD_FOOTER}\n`);
      return;
    }
    console.log(`${d.agents} subagents in ${d.sessionsWithAgents} of ${all.summary.sessions} sessions [derived]`);
    console.log(`  a typical one costs ${usd(d.medianAgentCostUSD)}, starts with ~${Math.round(d.medianAgentStartTokens / 1000)}k tokens of its own context, and hands ~${d.medianAnswerTokens} tokens back to the conversation`);
    console.log(`  ${d.lightAgents} made three calls or fewer (${usd(d.lightAgentsUSD)}): mostly start-up cost`);
    console.log(`\nFAN-OUT VERDICTS (swarm = 4+ at once or 8+ in total, and over ${pct(0.1)} of the session's spend; heavy = no swarm, but subagents are over ${pct(0.4)} of it)`);
    console.log(`  swarm ×${d.verdicts.swarm || 0} · heavy ×${d.verdicts.heavy || 0} · ok ×${d.verdicts.ok || 0}; swarm sessions spent ${usd(d.swarmSpendUSD)} on subagents = ${pct(d.swarmSpendUSD / all.summary.totalCostUSD)} of all spend [derived]`);
    for (const r of withAgents.slice(0, 8)) {
      const f = r.delegation;
      console.log(`  ${r.sessionId.slice(0, 8)}…  ${f.verdict.toUpperCase().padEnd(5)} ${String(f.agents).padStart(3)} agents, up to ${f.peakConcurrent} at once, ${usd(f.sideUSD)} of ${usd(r.totalCostUSD)} (${pct(f.shareOfSession)})`);
    }
    console.log(`\nVERY LARGE TOOL OUTPUTS KEPT IN THE CONVERSATION (5k+ tokens)`);
    console.log(`  ${d.verboseOutputs} of them; carrying them cost ${usd(d.verboseCarryUSD)} [estimated]`);
    console.log(`  one subagent per session reading them and returning a short answer would have netted ${usd(d.verboseNetSavingUSD)} after its own cost, and pays in ${d.sessionsWhereDelegatingPays} sessions [estimated]`);
    console.log(`\nWHAT THIS SAYS: delegating pays for work that reads a lot and returns little, done once. It does not pay one command at a time (every subagent starts with ~${Math.round(d.medianAgentStartTokens / 1000)}k tokens), and parallel swarms multiply that start-up. Whether a swarm was worth it depends on what it produced, which logs cannot show.\n${METHOD_FOOTER}\n`);
    return;
  },
  "__refresh-digest": async (args) => {
    try {
      const d = computeDigest();
      if (d) writeDigest(d);
    } finally {
      clearDigestLock();
    }
    return;
  },
  "digest": async (args) => {
    const d = computeDigest();
    if (!d) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    if (!args.includes("--json")) writeDigest(d, Date.now(), { shown: true }); // reading it by hand counts as the weekly digest: the hook will not repeat it
    if (args.includes("--json")) {
      console.log(JSON.stringify(d, null, 2));
      return;
    }
    const usd = (/** @type {number} */ n) => `$${Math.round(n).toLocaleString("en-US")}`;
    const day = (/** @type {string} */ iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
    const s = d.spend;
    console.log(`\n⚡ SPARELIMIT WEEKLY DIGEST: the last 7 days`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`Spend ${usd(s.thisWeekUSD)} at list price${s.weeklyLimitPct != null ? ` (≈${s.weeklyLimitPct}% of a weekly plan limit)` : ""}; the 7 days before: ${usd(s.lastWeekUSD)}${s.changePct != null ? ` (${s.changePct >= 0 ? "+" : ""}${s.changePct}%)` : ""} [derived]`);
    if (s.busiestDay) console.log(`Busiest day: ${day(s.busiestDay.date)}, ${usd(s.busiestDay.usd)}`);
    console.log(`${d.sessionsEnded} session${d.sessionsEnded === 1 ? "" : "s"} ended this week.`);
    if (d.habits) {
      console.log(`\nWHAT TO CHANGE (from this week's sessions; whole-session figures, estimated, overlapping)`);
      for (const h of d.habits.savings.filter((x) => x.usd > 0)) console.log(`  ${usd(h.usd).padEnd(6)} ${h.title}`);
      if (d.focus) console.log(`\nFOCUS FOR NEXT WEEK: ${d.focus.title}\n  How: ${d.focus.how}`);
    }
    if (d.swarms.length) console.log(`\nSWARMS: ${d.swarms.map((x) => `${x.agents} subagents (up to ${x.peakConcurrent} at once) cost ${usd(x.sideUSD)} of ${usd(x.totalUSD)}`).join("; ")}. Run \`sparelimit delegate\` for when that pays.`);
    if (d.breaks.times) console.log(`\nBREAKS: ${d.breaks.times} time${d.breaks.times === 1 ? "" : "s"} you came back to a big conversation after the cache went cold (${usd(d.breaks.extraVsWarmUSD)} more than a warm cache).`);
    if (d.adoption.length) {
      console.log(`\nHABITS YOU ARE TRACKING (run \`sparelimit track\` for the numbers)`);
      for (const h of d.adoption) console.log(`  ${h.id.padEnd(16)}${h.verdict}${h.reason ? ` (${h.reason})` : ""}  since ${h.start.date}`);
    }
    if (d.ledger?.interventions) console.log(`\nSAVINGS LEDGER (this week; \`sparelimit ledger\` for the entries): counted ${usd(d.ledger.countedUSD)} from ${d.ledger.counted} of ${d.ledger.interventions} interventions; ${d.ledger.ignored} ignored, ${d.ledger.pending} too recent`);
    const n = Object.entries(d.nudges);
    console.log(`\nNUDGES SHOWN BY SPARELIMIT THIS WEEK: ${n.length ? n.map(([k, v]) => `${k} ×${v}`).join(", ") : "none"}`);
    console.log(`\n${d.note}\n${METHOD_FOOTER}\n`);
    return;
  },
  "models": async (args) => {
    const all = replayAll();
    if (!all) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    const m = all.summary.models;
    if (args.includes("--json")) {
      console.log(JSON.stringify(m, null, 2));
      return;
    }
    const usd = (/** @type {number} */ n) => `$${Math.round(n).toLocaleString("en-US")}`;
    console.log(`\n⚡ SPARELIMIT MODELS: what could run one tier down`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`${usd(m.expensiveUSD)} of your ${usd(all.summary.totalCostUSD)} ran on Opus or Fable [derived]. Same tokens priced one tier down (Opus→Sonnet 5.5, Fable→Opus 5.5) [estimated]:\n`);
    console.log(`  ${"work".padEnd(10)}${"risk".padEnd(8)}${"spend".padStart(8)}${"saving".padStart(9)}  what the response did`);
    /** @type {Record<string, string>} */
    const what = { run: "ran shell commands only", explore: "read, searched or fetched only", mcp: "drove a browser or other MCP tool", edit: "edited or wrote files", mixed: "mixed tool use", delegate: "handed work to a subagent", think: "no tool call: planning, explaining, deciding" };
    for (const r of m.rows) console.log(`  ${r.type.padEnd(10)}${r.risk.padEnd(8)}${usd(r.usd).padStart(8)}${usd(r.savingUSD).padStart(9)}  ${what[r.type]}`);
    console.log(`\n  If moved: low risk ${usd(m.tierSavingUSD.low)} · medium ${usd(m.tierSavingUSD.medium)} · high ${usd(m.tierSavingUSD.high)} (these overlap with the other habits: not additive)`);
    console.log(`  The risk tiers are a rule of thumb, not a measurement: a log shows what a response did, not how hard the thinking was.`);
    if (m.evidence.length) {
      console.log(`\nYOUR OWN HISTORY, as a rough quality signal (tool calls that came back as errors; harder work may have gone to Opus, so this is not like for like)`);
      for (const e of m.evidence) console.log(`  ${e.type === "run" ? "commands" : "edits   "}  Opus ${e.opus?.failedPct}% of ${e.opus?.calls}  ·  Sonnet ${e.sonnet?.failedPct}% of ${e.sonnet?.calls}`);
    }
    const sub = m.subagentTypes.filter((x) => x.expensiveUSD > 0).slice(0, 6);
    if (sub.length) {
      console.log(`\nSUBAGENTS RUNNING ON OPUS OR FABLE (set a cheaper model for the types that do routine work, in their agent definition)`);
      for (const x of sub) console.log(`  ${x.type.padEnd(22)}${String(x.agents).padStart(3)} agents  ${usd(x.expensiveUSD).padStart(6)} on the expensive model`);
    }
    console.log(`\nHOW TO TRY IT: pick one low-risk kind of work, run it on Sonnet for a week, and compare retries and rework before moving more. Quality is the thing this tool cannot measure for you.\n${METHOD_FOOTER}\n`);
    return;
  },
  "adopt": async (args) => {
    const habit = args[1] && !args[1].startsWith("-") ? args[1] : null;
    if (!habit) {
      const m = readMarkers();
      console.log(`\nHabits Sparelimit can track (sparelimit adopt <habit> [--date=YYYY-MM-DD]):`);
      for (const [id, h] of Object.entries(HABITS)) console.log(`  ${id.padEnd(16)}${h.title}${m[id] ? `   [started ${m[id].date}]` : ""}`);
      console.log(`\nTell Sparelimit the day you started a habit and \`sparelimit track\` compares the time before and after.\n`);
      return;
    }
    if (!(/** @type {Record<string, unknown>} */ (HABITS))[habit]) {
      console.error(`Unknown habit "${habit}". Run \`sparelimit adopt\` to list them.`);
      process.exit(1);
    }
    if (args.includes("--clear")) {
      clearMarker(habit);
      console.log(`✓ Cleared the start date for ${habit}.`);
      return;
    }
    const given = args.find((a) => a.startsWith("--date="))?.slice(7);
    const when = given && given !== "today" ? Date.parse(`${given}T00:00:00Z`) : Date.now();
    if (!Number.isFinite(when) || when > Date.now() + 86400e3) {
      console.error("Use a past date like --date=2026-11-01.");
      process.exit(1);
    }
    setMarker(habit, when);
    console.log(`✓ ${/** @type {Record<string, { title: string }>} */ (HABITS)[habit].title}: start date ${new Date(when).toISOString().slice(0, 10)}. Run \`sparelimit track\` after a week to see what changed.`);
    return;
  },
  "track": async (args) => {
    const all = replayAll();
    if (!all) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    let auditRows = [];
    try {
      auditRows = fs.readFileSync(auditPath(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch {}
    const a = buildAdoption({ results: all.results, markers: readMarkers(), auditRows });
    if (args.includes("--json")) {
      console.log(JSON.stringify(a, null, 2));
      return;
    }
    const fmt = (/** @type {any} */ h, /** @type {any} */ v) => (v == null ? "-" : h.metric === "startMedian" ? `${Math.round(v / 1000)}k` : `${v}`);
    console.log(`\n⚡ SPARELIMIT TRACK: did the habit change, and did the cost drop?`);
    console.log(`──────────────────────────────────────────────────────────────`);
    for (const h of a.habits) {
      const def = HABITS[h.id];
      console.log(`\n${h.id}  ${h.title}`);
      console.log(`  ${h.periodNote}`);
      console.log(`  ${def.unit}: ${fmt(def, /** @type {Record<string, any>} */ (h.before)[def.metric])} → ${fmt(def, /** @type {Record<string, any>} */ (h.after)[def.metric])}   [${h.verdict}${h.verdict === "improved" || h.verdict === "worse" ? `, ${(h.changePct ?? 0) > 0 ? "+" : ""}${h.changePct ?? "n/a"}%` : `: ${h.reason}`}]`);
      if (h.costPer100) console.log(`  cost per 100 responses: $${h.costPer100.before} → $${h.costPer100.after}${h.costPer100.changePct != null ? ` (${h.costPer100.changePct > 0 ? "+" : ""}${h.costPer100.changePct}%)` : ""}   (responses: ${h.before.responses} before, ${h.after.responses} after)`);
      console.log(`  by week:  ${h.weekly.map((w) => fmt(def, w.value)).join(" · ")}  (oldest to newest)`);
    }
    console.log(`\n${a.note}\nSet a start date with \`sparelimit adopt <habit>\` so the comparison is around the day you changed.\n${METHOD_FOOTER}\n`);
    return;
  },
  "week": async (args) => {
    const flag = args.find((a) => a.startsWith("--days="));
    const days = flag ? Number(flag.slice(7)) || 0 : SUMMARY_DAYS; // --days=0 is everything
    const r = readWeek({ days });
    if (!r) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    const share = args.includes("--share");
    const week = share ? shareWeek(r.week) : r.week;
    const out = args.includes("--json") ? JSON.stringify(week, null, 2) : renderWeekText(week);
    console.log(out);
    if (share) shareCheck(out, "this summary");
    await afterReport({ entries: r.ledger.entries, ran: true, mayAsk: !share && !args.includes("--json") });
    return;
  },
  "ledger": async (args) => {
    const all = replayAll();
    if (!all) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    const days = Number(args.find((a) => a.startsWith("--days="))?.slice(7)) || 0;
    const l = buildLedger({ auditRows: readAuditRows(), results: all.results, weeklyLimitUSD: fitLimits(loadCalibration().points).weeklyUSD, sinceMs: days ? Date.now() - days * 86400e3 : 0 });
    const share = args.includes("--share");
    if (args.includes("--json")) {
      const out = JSON.stringify(share ? shareLedger(l) : l, null, 2);
      console.log(out);
      if (share) shareCheck(out, "this ledger");
      await afterReport({ entries: l.entries, mayAsk: false });
      return;
    }
    /** @type {string[]} */
    const lines = [];
    const print = share ? (/** @type {string} */ x = "") => { lines.push(x); console.log(x); } : console.log;
    const t = l.totals;
    const usd = (/** @type {number} */ n) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    print(`\n⚡ SPARELIMIT SAVINGS LEDGER${days ? ` (last ${days} days)` : ""}`);
    print(`──────────────────────────────────────────────────────────────`);
    if (!t.interventions) {
      print(`No alerts have been logged yet, so there is nothing to count. A saving is counted only when an alert fired, you acted,\nand a comparable cost was measured afterwards. The coach logs its nudges as they happen.\n${METHOD_FOOTER}\n`);
      if (share) shareCheck(lines.join("\n"), "this ledger");
      return;
    }
    print(`COUNTED (alert fired · you acted · cost measured afterwards): ${usd(t.countedUSD)}${t.countedPctOfWeeklyLimit != null ? ` (≈${t.countedPctOfWeeklyLimit}% of a weekly limit)` : ""} from ${t.counted} of ${t.interventions} interventions`);
    if (t.actedOnRate != null) print(`ACTED ON: ${t.actedOnRate}% of the alerts where it could be told (${t.actedOn} acted on, ${t.ignored} ignored). Whether the alert was the reason is not known.`);
    print(`NOT COUNTED: ${t.ignored} ignored${t.ignoredPredictedUSD ? ` (they predicted ${usd(t.ignoredPredictedUSD)}, which was not saved)` : ""} · ${t.pending} too recent · ${t.stopped} work stopped · ${t.overlap} overlapping · ${t.noData} without enough data`);
    print(`WHERE THEY WENT: ${breakdownEquation(breakdownFromTotals(t))}`);
    print(`RULES: version ${l.rulesVersion}. Every rule and threshold is in docs/RULES.md.`);
    /** @type {Record<string, string>} */
    const label = { reset: "reset", cold: "cold cache", quota: "plan limit" };
    print("");
    for (const e of l.entries) {
      const when = share ? shareDay(e.at) : e.at.slice(0, 16).replace("T", " ");
      const money = e.status === "counted" ? usd(e.savingUSD) : e.predictedUSD ? `predicted ${usd(e.predictedUSD)}` : "";
      print(`${when}  ${label[e.family].padEnd(10)} ${e.status.toUpperCase().padEnd(8)} ${money.padEnd(18)} ${e.status === "counted" ? e.how : e.note || ""}`);
      if (e.status === "counted" && e.method) print(`${" ".repeat(18)}${e.method} [${e.confidence}]`);
    }
    print(`\n${l.note}\n${METHOD_FOOTER}\n`);
    if (share) shareCheck(lines.join("\n"), "this ledger");
    await afterReport({ entries: l.entries, mayAsk: !share });
    return;
  },
  "method": async (args) => {
    const id = args[1] && !args[1].startsWith("-") ? args[1] : null;
    if (id && !METHOD.sections.some((s) => s.id === id)) {
      console.error(`Unknown section "${id}". Sections: ${METHOD.sections.map((s) => s.id).join(", ")}`);
      process.exit(1);
    }
    console.log(renderMethodText(METHOD, id));
    return;
  },
  "rebuild": async (args) => {
    const rows = [];
    for (const x of listClaudeSessions()) {
      const session = parseTranscript(x.filePath);
      if (session?.events?.length) rows.push(...rebuildEvents(session.events).map((r) => ({ session: x.id.slice(0, 8), ...r })));
    }
    const sum = summarizeRebuild(rows);
    if (args.includes("--json")) {
      console.log(JSON.stringify({ summary: sum, events: rows }, null, 2));
      return;
    }
    const k = (/** @type {number | null} */ n) => (n == null ? "n/a" : `${(n / 1000).toFixed(1)}k`);
    console.log(`\n⚡ SPARELIMIT HANDOFF REBUILD  (X15)`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`${sum.events} real shrinks (a /compact, an auto-compaction or a /clear) with ${REBUILD.minAfter}+ responses after, across ${listClaudeSessions().length} sessions.`);
    console.log(`In the ${REBUILD.windowResponses} responses after a shrink, files already read earlier were read again:`);
    console.log(`  median ${k(sum.medianReReadTokens)} tokens   (middle half: ${k(sum.p25ReReadTokens)} to ${k(sum.p75ReReadTokens)};  ${sum.zeroShare}% re-read nothing)`);
    console.log(`  new files read in the same stretch: median ${k(sum.medianNewReadTokens)} tokens`);
    console.log(`Upper bounds, since new work is in them too: all tool output in those responses, median ${k(sum.medianToolOutputTokens)} (75th percentile ${k(sum.p75ToolOutputTokens)}); context growth over them, median ${k(sum.medianGrowthTokens)} (75th ${k(sum.p75GrowthTokens)}).`);
    console.log(`The reset model assumes ${k(sum.modelAssumesTokens)} tokens are re-read after a reset.`);
    console.log(`[${sum.confidence}]`);
    console.log(`A compaction keeps a summary; a fresh start with a short handoff keeps less, so it probably re-reads more than this.\n${METHOD_FOOTER}\n`);
    return;
  },
  "card": async (args) => {
    const all = replayAll();
    if (!all) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    const habits = buildHabitCard(all.summary, { weeklyLimitUSD: fitLimits(loadCalibration().points).weeklyUSD });
    const card = buildCard({ habits, spend: all.summary.spendBreakdownUSD, hideDollars: args.includes("--hide-dollars") });
    const outArg = args.find((a) => a.startsWith("--out="))?.slice(6);
    const dir = path.resolve(outArg || process.cwd());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "sparelimit-card.svg"), renderCardSvg(card));
    fs.writeFileSync(path.join(dir, "sparelimit-card.html"), renderCardHtml(card));
    console.log(`✓ Wrote ${path.join(dir, "sparelimit-card.svg")} (an image) and ${path.join(dir, "sparelimit-card.html")} (a page).`);
    console.log(`They hold totals, shares and labels only: no prompts, project names or paths.${card.hideDollars ? " Dollar amounts are left out." : " Add --hide-dollars to leave the amounts out."}`);
    if (args.includes("--share")) {
      for (const f of ["sparelimit-card.svg", "sparelimit-card.html"]) shareCheck(fs.readFileSync(path.join(dir, f), "utf8"), f);
      console.error("The picture itself cannot be checked by a program: look at it once at full size before you post it. See docs/SCREENSHOTS.md.");
    }
    return;
  },
  "why": async (args) => {
    const arg = args[1] && !args[1].startsWith("-") ? args[1] : "latest";
    const tl = timelineFor(arg);
    if (!tl) {
      console.error(arg === "latest" ? noLogsMessage() : `No session matching "${arg}". Use an id from \`sparelimit timeline\` output or the dashboard.`);
      process.exit(1);
    }
    if (args.includes("--json")) {
      console.log(JSON.stringify(tl.why, null, 2));
      return;
    }
    const w = tl.why;
    const money = (/** @type {number} */ n) => `$${n.toFixed(2)}`;
    console.log(`\n⚡ WHY THIS SESSION COST WHAT IT DID  ${w.sessionId.slice(0, 8)}…  ${tl.project || ""}`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`${money(w.totalUSD)} at list price over ${tl.responses} responses. Causes, largest first:\n`);
    if (!w.causes.length) console.log("  Nothing stands out: no single cause is 1% or more of this session's spend.");
    w.causes.forEach((c, i) => {
      console.log(`${String(i + 1).padStart(2)}. ${money(c.usd).padStart(9)}  ${String(c.sharePct.toFixed(1) + "%").padStart(6)}  ${c.title}  [${c.kind}, ${c.confidence}]`);
      console.log(`${" ".repeat(24)}${c.detail}`);
      console.log(`${" ".repeat(24)}Try: ${c.fix}`);
    });
    console.log(`\n${w.note}\n${METHOD_FOOTER}\n`);
    return;
  },
  "timeline": async (args) => {
    const arg = args[1] && !args[1].startsWith("-") ? args[1] : "latest";
    const tl = timelineFor(arg);
    if (!tl) {
      console.error(arg === "latest" ? noLogsMessage() : `No session matching "${arg}". Use an id from \`sparelimit timeline\` output or the dashboard.`);
      process.exit(1);
    }
    if (args.includes("--json")) {
      console.log(JSON.stringify(tl, null, 2));
      return;
    }
    const usd = (/** @type {number} */ n) => `$${Math.round(n).toLocaleString("en-US")}`;
    const ticks = " ▁▂▃▄▅▆▇█";
    const cols = 64;
    const per = Math.max(1, Math.ceil(tl.points.length / cols));
    let spark = "";
    for (let i = 0; i < tl.points.length; i += per) {
      const m = Math.max(...tl.points.slice(i, i + per).map((p) => p.pct ?? 0));
      spark += ticks[Math.max(0, Math.min(8, Math.round((Math.min(100, m) / 100) * 8)))];
    }
    const d = (/** @type {string} */ iso) => new Date(iso).toISOString().slice(0, 16).replace("T", " ");
    console.log(`\n⚡ SPARELIMIT SESSION TIMELINE  ${tl.sessionId.slice(0, 8)}…  ${tl.project || ""}`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`${tl.responses} responses · ${usd(tl.totalUSD)} at list price · ${tl.summary.activeMinutes} active min over ${tl.summary.calendarDays} days (${d(tl.start)} to ${d(tl.end)}) [derived]`);
    console.log(`\ncontext  ${spark}   (each column is ${per} response${per === 1 ? "" : "s"}; full height = the window; warning at ${tl.thresholds.warnPct}%, stop at ${tl.thresholds.stopPct}%)`);
    const a = tl.summary.aboveWarn;
    console.log(`\n${a.shareOfResponses}% of the responses and ${usd(a.usd)} (${a.shareOfSpend}% of the spend) happened at ${tl.thresholds.warnPct}% of the window or more [derived]`);
    const er = tl.summary.earlierReset;
    if (er) console.log(`Starting fresh at 60% instead of waiting for auto-compaction would have saved about ${usd(er.savingUSD)} (range ${usd(er.lowUSD)} to ${usd(er.highUSD)}) [estimated]`);
    const c = tl.summary.counts;
    console.log(`Moments: ${Object.entries(c).map(([k, v]) => `${v} ${k}`).join(" · ") || "none"}${tl.gaps.length ? ` · ${tl.gaps.length} pauses of an hour or more` : ""}`);
    const shown = args.includes("--all") ? tl.moments : tl.moments.slice(0, 25);
    console.log("");
    const cents = (/** @type {number} */ n) => `$${n.toFixed(2)}`;
    for (const m of shown) {
      console.log(`${String(m.id).padStart(3)}  ${d(new Date(m.t).toISOString())}  #${String(m.n).padEnd(5)} ${String(Math.round(m.pct ?? 0)).padStart(3)}%  ${usd(m.cumUSD).padStart(5)}  ${m.kind.padEnd(9)} ${m.label}`);
      if (m.compare) console.log(`${" ".repeat(10)}before/after: ${cents(m.compare.before.costPerResponse)} per response over ${m.compare.before.responses} before (about ${m.compare.before.meanPct}% of the window) → ${cents(m.compare.after.costPerResponse)} over ${m.compare.after.responses} after (about ${m.compare.after.meanPct}%)${m.compare.changePct == null ? "" : `, ${m.compare.changePct > 0 ? "+" : ""}${m.compare.changePct}%`} [measured; the work may differ]`);
    }
    if (tl.moments.length > shown.length) console.log(`     … ${tl.moments.length - shown.length} more (add --all)`);
    console.log(`\n${METHOD_FOOTER}\n`);
    return;
  }
};
