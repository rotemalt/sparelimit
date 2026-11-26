/** Commands that read your history across agents and sessions: history, drains, files, efficacy, quota-fit, gemini. Split out of analysis.mjs (A11). */
import { noLogsMessage } from "../emptystate.mjs";
import fs from "node:fs";
import { buildDrains } from "../drains.mjs";
import { buildEfficacy } from "../efficacy.mjs";
import { buildFileHygiene } from "../files.mjs";
import { buildHistory } from "../history.mjs";
import { buildValue } from "../value.mjs";
import { summarizeGemini } from "../geminireport.mjs";
import { cursorDbPath, readCursorMessages, summarizeCursor } from "../cursorreport.mjs";
import { fitTokenClasses } from "../quotafit.mjs";
import { readDesktopPlanSamples, usableFiveHour } from "../desktopplan.mjs";
import { accountScope, fiveHourWindows, fitLimits, loadCalibration } from "../planestimate.mjs";
import { priceEvent } from "../analyze.mjs";
import { METHOD_FOOTER } from "../constants.mjs";
import { geminiSessionFiles } from "../sources.mjs";
import { discoverTranscripts, readAuditRows, replayAll } from "../transcripts.mjs";
import { loadPricing as loadPricingForHealth } from "../pricing.mjs";
import { parseTranscript } from "../adapters/index.mjs";
import { summarize } from "../replay.mjs";

/** Dollars with cents and thousands separators, shared by the commands below. */
const usd = (/** @type {number} */ n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** @type {Record<string, (args: string[]) => Promise<void>>} */
export const commands = {
  "history": async (args) => {
    const all = replayAll();
    if (!all) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    const days = Math.min(365, Math.max(1, Number(args.find((a) => a.startsWith("--days="))?.slice(7)) || 30));
    const h = buildHistory(all.results, { days });
    if (args.includes("--json")) {
      console.log(JSON.stringify(h, null, 2));
      return;
    }
    console.log(`\n⚡ SPARELIMIT HISTORY: the last ${days} days  ${usd(h.totalUSD)} over ${h.sessions} sessions`);
    console.log(`──────────────────────────────────────────────────────────────`);
    const max = Math.max(1, ...h.weekly.map((w) => w.usd));
    console.log(`BY WEEK (from Monday)`);
    for (const w of h.weekly) console.log(`  ${w.weekStart}  ${usd(w.usd).padStart(10)}  ${"█".repeat(Math.round((w.usd / max) * 30))}`);
    console.log(`\nBY PROJECT`);
    for (const p of h.projects) console.log(`  ${usd(p.usd).padStart(10)}  ${p.project.slice(0, 50).padEnd(50)} ${p.sessions} session${p.sessions > 1 ? "s" : ""}`);
    console.log(`\nTOP CAUSES (each on its own; they overlap and are not added up)`);
    for (const c of h.causes) console.log(`  ${usd(c.usd).padStart(10)}  ${c.title}  [${c.kind}, ${c.confidence}; ${c.sessions} session${c.sessions > 1 ? "s" : ""}]`);
    console.log(`\n${h.note} [${h.confidence}]\n`);
    return;
  },
  "value": async (args) => {
    const num = (/** @type {string} */ k) => {
      const v = Number(args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3));
      return Number.isFinite(v) && v > 0 ? v : null;
    };
    const planUSD = num("plan");
    if (!planUSD) {
      console.error("Pass what you pay per month: `sparelimit value --plan=<dollars>` (for example --plan=20, 100 or 200). Optional: --days=N, --allowance=<monthly dollars>, --rate=<overage multiple of list>, --json.");
      process.exit(1);
    }
    const all = replayAll();
    if (!all) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    const days = Math.min(365, Math.max(1, num("days") || 30));
    const h = buildHistory(all.results, { days });
    const v = buildValue({ usedUSD: h.totalUSD, days, planUSD, weeklyLimitUSD: fitLimits(loadCalibration().points).weeklyUSD, allowanceUSD: num("allowance"), rate: num("rate") || 1 });
    if (args.includes("--json")) {
      console.log(JSON.stringify(v, null, 2));
      return;
    }
    console.log(`\n⚡ SPARELIMIT VALUE: what you used against what you pay (last ${days} days)`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`Your plan:                    ${usd(v.planUSD)} a month`);
    console.log(`Used at list price:           ${usd(v.usedUSD)} (${usd(v.monthlyUsedUSD)} per 30 days) [derived]`);
    if (v.valueMultiple != null) console.log(`Used versus paid:             ${v.valueMultiple}x`);
    console.log(`Pay per use, no plan:         ${usd(v.payPerUseUSD)} a month`);
    if (v.hybrid) {
      console.log(`\nIF PRICING BECAME A BASE PLUS PAY-PER-COST [scenario, not a quote]`);
      console.log(`  base ${usd(v.hybrid.baseUSD)} includes ${usd(v.hybrid.allowanceUSD)} (${v.allowanceSource}); above that, list price x ${v.hybrid.rate}`);
      console.log(`  overage ${usd(v.hybrid.overageUSD)} → ${usd(v.hybrid.totalUSD)} a month`);
    } else console.log(`\nNo hybrid scenario: no fitted limit yet. Pass --allowance=<monthly dollars the base would include>.`);
    console.log(`\n${v.note} [${v.confidence}]\n`);
    return;
  },
  "drains": async (args) => {
    const all = replayAll();
    if (!all) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    const d = buildDrains(summarize(all.results));
    if (args.includes("--json")) {
      console.log(JSON.stringify(d, null, 2));
      return;
    }
    console.log(`\n⚡ SPARELIMIT DRAINS: spend on turns you did not type`);
    console.log(`──────────────────────────────────────────────────────────────`);
    if (!d.rows.length) {
      console.log(`Nothing found: every main-thread response followed a prompt you typed (${usd(d.typedUSD)}).\n`);
      return;
    }
    for (const r of d.rows) console.log(`${usd(r.usd).padStart(10)}  ${String(r.shareOfSpend).padStart(5)}%  ${r.label} (${r.responses} responses, ${r.sessions} session${r.sessions > 1 ? "s" : ""})`);
    console.log(`\n${usd(d.unpromptedUSD)} unprompted, against ${usd(d.typedUSD)} after prompts you typed. ${d.note} [${d.confidence}]\n`);
    return;
  },
  "files": async (args) => {
    const all = replayAll();
    if (!all) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    const h = buildFileHygiene(all.results);
    if (args.includes("--json")) {
      console.log(JSON.stringify(h, null, 2));
      return;
    }
    console.log(`\n⚡ SPARELIMIT FILES: what reading each file cost`);
    console.log(`──────────────────────────────────────────────────────────────`);
    if (!h.files.length) {
      console.log(`No file reads found in the sessions.\n`);
      return;
    }
    for (const f of h.files) console.log(`${("$" + f.carryUSD.toFixed(2)).padStart(8)}  ${f.name.padEnd(46).slice(0, 46)} ${String(f.reads).padStart(4)} reads (${f.wholeReads} whole), largest ${(f.largestReadTokens / 1000).toFixed(1)}k tokens, ${f.sessions} session${f.sessions > 1 ? "s" : ""}${f.flag ? `  ← ${f.flag}` : ""}`);
    console.log(`\n${h.flagged} of ${h.totalFiles} files flagged. ${h.note} [${h.confidence}]\n`);
    return;
  },
  "efficacy": async (args) => {
    const all = replayAll();
    if (!all) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    const days = Number(args.find((a) => a.startsWith("--days="))?.slice(7)) || 0;
    const e = buildEfficacy(readAuditRows(), all.results, { sinceMs: days ? Date.now() - days * 86400e3 : 0 });
    if (args.includes("--json")) {
      console.log(JSON.stringify(e, null, 2));
      return;
    }
    console.log(`\n⚡ SPARELIMIT EFFICACY: what the spend did after each message${days ? ` (last ${days} days)` : ""}`);
    console.log(`──────────────────────────────────────────────────────────────`);
    if (!e.rules.length) {
      console.log(`No warnings, nudges or playbook messages have been logged yet.\n`);
      return;
    }
    console.log(`${"rule".padEnd(30)} measured  slowed  held  rose  went quiet  (too recent / no data)`);
    for (const r of e.rules) console.log(`${r.rule.padEnd(30)} ${String(r.measured).padStart(8)} ${String(r.slowed).padStart(7)} ${String(r.held).padStart(5)} ${String(r.rose).padStart(5)} ${String(r.quiet).padStart(11)}  (${r.tooRecent} / ${r.noData})`);
    console.log(`\n${e.note} [${e.confidence}]\n`);
    return;
  },
  "quota-fit": async (args) => {
    // readings of the five-hour percentage from the Desktop app's own history, each with the tokens the Claude Code logs show in that window
    const samples = usableFiveHour(readDesktopPlanSamples());
    const pricing = loadPricingForHealth();
    /** @type {{ t: number, u: any, cost: number }[]} */
    const ev = [];
    const mine = accountScope(); // the Desktop app's readings are of the default account: only its logs belong in the window
    for (const f of discoverTranscripts(undefined, { global: true })) {
      if (!mine(f.filePath)) continue;
      const sess = parseTranscript(f.filePath);
      if (!sess || sess.agent !== "claude-code") continue;
      for (const e of sess.events) ev.push({ t: Date.parse(e.ts), u: e.usage, cost: priceEvent(e, pricing).cost });
    }
    const wins = fiveHourWindows(ev.map((e) => e.t));
    const rows = [];
    for (const x of samples) {
      const w = wins.find((v) => x.t >= v.start && x.t < v.end);
      if (!w) continue;
      const a = { pct: x.fiveHourPct, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0 };
      for (const e of ev) if (e.t >= w.start && e.t <= x.t) {
        a.input += e.u.input;
        a.cacheRead += e.u.cacheRead;
        a.cacheWrite += e.u.cacheWrite5m + e.u.cacheWrite1h;
        a.output += e.u.output;
        a.usd += e.cost;
      }
      if (a.usd > 0) rows.push(a);
    }
    const fit = fitTokenClasses(rows);
    if (args.includes("--json")) {
      console.log(JSON.stringify({ ...fit, readings: rows.length }, null, 2));
      return;
    }
    console.log(`\n⚡ SPARELIMIT QUOTA FIT: how much of the five-hour limit each kind of token uses`);
    console.log(`──────────────────────────────────────────────────────────────`);
    if (fit.status === "insufficient") {
      console.log(fit.note);
      console.log(`\nWhat there is today (the percentage the app showed, and what your logs say was spent in that window):`);
      for (const r of rows) console.log(`  ${String(r.pct).padStart(3)}%   cache re-reads ${(r.cacheRead / 1e6).toFixed(1)}M · cache writes ${(r.cacheWrite / 1e6).toFixed(2)}M · input ${(r.input / 1e6).toFixed(2)}M · output ${(r.output / 1e6).toFixed(2)}M · $${r.usd.toFixed(2)}`);
      console.log(`\nKeep using \`sparelimit calibrate\` and the Desktop app; run this again when there are ${fit.needRows}+ readings.\n`);
      return;
    }
    console.log(`${fit.rows} readings. Points of the five-hour limit per million tokens:`);
    for (const [k, v] of Object.entries(fit.coefficientsPctPerMillionTokens ?? {})) console.log(`  ${k.padEnd(11)} ${v}`);
    console.log(`\nR² ${fit.r2}. Leave-one-out error: ${fit.medianAbsErrorPoints} points; the dollar model the planner uses: ${fit.dollarModelMedianAbsErrorPoints ?? "n/a"} points. ${fit.beatsDollarModel ? "The token-class model is closer." : "The dollar model is as close or closer: keep using it."}`);
    console.log(`${fit.note} [${fit.confidence}]\n`);
    return;
  },
  "cursor": async (args) => {
    let sum;
    try {
      sum = summarizeCursor(readCursorMessages(cursorDbPath()));
    } catch (/** @type {any} */ e) {
      console.error(e.message);
      process.exit(1);
    }
    if (args.includes("--json")) {
      console.log(JSON.stringify(sum, null, 2));
      return;
    }
    const m = (/** @type {number} */ n) => `${(n / 1e6).toFixed(1)}M`;
    console.log(`\n⚡ SPARELIMIT CURSOR: what your Cursor chats used (tokens only)`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`${sum.sessions} sessions · ${sum.messages.toLocaleString("en-US")} messages · ${m(sum.tokens.total)} tokens (${m(sum.tokens.input)} in, ${m(sum.tokens.output)} out) · no dollar figure [${sum.confidence}]`);
    console.log(`${sum.messagesWithoutModel.toLocaleString("en-US")} messages name no model; ${sum.messagesWithoutDate.toLocaleString("en-US")} have no date.`);
    if (sum.byModel.length) {
      console.log(`\nBY MODEL (where named)`);
      for (const x of sum.byModel) console.log(`  ${m(x.tokens).padStart(8)}  ${x.model}`);
    }
    console.log(`\nLAST 14 DAYS`);
    for (const d of sum.last14Days) console.log(`  ${d.day}  ${m(d.tokens).padStart(8)}`);
    console.log(`\nLARGEST SESSIONS`);
    for (const t of sum.top) console.log(`  ${m(t.input + t.output).padStart(8)}  ${t.id.slice(0, 8)}  ${t.start ? t.start.slice(0, 10) : "undated"}  (${t.messages} messages)`);
    console.log(`\n${sum.note}\n${METHOD_FOOTER}\n`);
    return;
  },
  "gemini": async (args) => {
    const files = geminiSessionFiles();
    if (!files.length) {
      console.error("No Gemini CLI sessions found in ~/.gemini/tmp (set GEMINI_CLI_HOME if yours are elsewhere).");
      process.exit(1);
    }
    const sessions = files.map((f) => parseTranscript(f)).filter((x) => x && x.agent === "gemini");
    const sum = summarizeGemini(sessions, { pricing: loadPricingForHealth() });
    if (args.includes("--json")) {
      console.log(JSON.stringify(sum, null, 2));
      return;
    }
    const m = (/** @type {number} */ n) => `${(n / 1e6).toFixed(1)}M`;
    console.log(`\n⚡ SPARELIMIT GEMINI: what your Gemini CLI sessions cost`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`${sum.sessions} sessions with usage (${sum.sessionsWithoutUsage} without) · ${sum.responses.toLocaleString("en-US")} responses · ${usd(sum.totalUSD)} at list price [${sum.confidence}]${sum.estimatedUSD ? `, of which ${usd(sum.estimatedUSD)} is on models missing from the price list [estimated]` : ""}`);
    console.log(`Tokens: ${m(sum.tokens.total)} in total, ${sum.tokens.cacheReadShare}% of them cache re-reads [as the log reports them]`);
    console.log(`\nBY MODEL`);
    for (const x of sum.byModel) console.log(`  ${usd(x.usd).padStart(10)}  ${x.model}  (${x.responses.toLocaleString("en-US")} responses)${x.priced ? "" : "  [not in the price list: default price, estimated]"}`);
    console.log(`\nLAST 14 DAYS`);
    for (const d of sum.last14Days) console.log(`  ${d.day}  ${usd(d.usd).padStart(9)}`);
    console.log(`\nLARGEST SESSIONS`);
    for (const t of sum.top) console.log(`  ${usd(t.totalUSD).padStart(10)}  ${String(t.id).slice(8, 24).padEnd(18)} ${t.project || ""}  (${t.responses} responses)`);
    console.log(`\n${sum.note}\n${METHOD_FOOTER}\n`);
    return;
  },
};
