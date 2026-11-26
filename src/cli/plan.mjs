/** Plan-limit commands: calibration, the plan view, budgets and policy presets. Split out of sparelimit.mjs (A11). */
import { METHOD_FOOTER } from "../constants.mjs";
import { PRESETS, mergePolicy } from "../policy.mjs";
import { addCalibrationPoint, estimatePlanUsage, fitLimits, loadCalibration, loadRecentEvents, parseResetSpec } from "../planestimate.mjs";
import { checkAgainstLogs, desktopPlanPath, readDesktopPlanSamples, usableFiveHour } from "../desktopplan.mjs";
import { checkBudgets } from "../budget.mjs";
import { configPath, readJson, writeJsonAtomic } from "../state.mjs";
import { describeWindow } from "../plan.mjs";
import { loadConfig, sanitizeBudgets } from "../config.mjs";
import { replayAll } from "../transcripts.mjs";
import { accountOf, claudeConfigDirs, currentConfigDir, resolveAccount } from "../accounts.mjs";

/** The config folder an --account=<path | label | id> names, else the current account's; exits with a clear message when it matches none or several. */
function pickAccount(/** @type {any} */ args) {
  const spec = args.find((/** @type {any} */ a) => a.startsWith("--account="))?.slice("--account=".length);
  if (!spec) return currentConfigDir();
  const settings = loadConfig();
  const dirs = claudeConfigDirs({ extra: settings.accounts.dirs });
  const dir = resolveAccount(spec, dirs, { labels: settings.accounts.labels });
  if (!dir) {
    console.error(`No single account matches "${spec}". Known: ${dirs.map((d) => `${accountOf(d, { labels: settings.accounts.labels }).label} (${d})`).join("; ") || "none"}. See \`sparelimit accounts\`.`);
    process.exit(2);
  }
  return dir;
}

/** @type {Record<string, (args: string[]) => Promise<void>>} one handler per command; `args` is the whole command line after `sparelimit`, args[0] being the command */
export const commands = {
  "calibrate": async (args) => {
    const arg = (/** @type {string} */ k) => args.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
    const five = arg("five");
    const weekly = arg("weekly");
    const account = pickAccount(args);
    if (args.includes("--from-app")) {
      const samples = usableFiveHour(readDesktopPlanSamples());
      if (!samples.length) {
        console.log(`No usable samples in the Claude Desktop app's plan-usage file (${desktopPlanPath()}). Use \`sparelimit calibrate --five=...\` with what the app shows.`);
        return;
      }
      const all = replayAll();
      const events = all ? all.results.flatMap((r) => r.timeline.map((/** @type {any} */ e) => ({ t: e.t, cost: e.cost }))) : [];
      const have = new Set(loadCalibration({ account }).points.map((/** @type {any} */ p) => p.at));
      let added = 0;
      for (const sm of samples) {
        if (have.has(new Date(sm.t).toISOString())) continue;
        const pt = addCalibrationPoint({ at: sm.t, fivePct: sm.fiveHourPct, weeklyPct: null, weeklyResetMs: null, events, account });
        if (pt.spendFive > 0) added++;
      }
      const lim = fitLimits(loadCalibration({ account }).points);
      console.log(`✓ Read ${samples.length} five-hour samples from the app's own record (between 15% and 95%); ${added} added as calibration points (the rest were already there, or the logs show no spend in that window).`);
      console.log(`Estimated 5-hour limit now: ≈ $${lim.fiveHourUSD?.toFixed(0) ?? "?"} of API-equivalent usage from ${lim.fiveHourPoints} points. The weekly figure is not imported: the app's weekly resets do not fall on a fixed 7 days, so no reset moment can be anchored from them.`);
      return;
    }
    if (five == null && weekly == null) {
      console.log(`Usage: sparelimit calibrate --five=60 --weekly=85 --weekly-reset="fri 14:00" [--at="12:56"]\n\nType in what the app shows (percent used). Sparelimit compares it with what your own logs say you spent in the same windows,\nso it can estimate your plan usage anywhere your logs are written, including the Claude Desktop app. More points make it better.`);
      return;
    }
    const atSpec = arg("at");
    const at = atSpec ? parseResetSpec(atSpec, Date.now() - 86400e3 + 1) : Date.now();
    const atMs = at && at > Date.now() ? at - 86400e3 : at || Date.now();
    const resetSpec = arg("weekly-reset");
    const weeklyResetMs = resetSpec ? parseResetSpec(resetSpec, atMs) : (loadCalibration({ account }).points.slice(-1)[0]?.weeklyResetMs ?? null);
    const events = await loadRecentEvents({ account });
    const point = addCalibrationPoint({ at: atMs, fivePct: five != null ? Number(five) : null, weeklyPct: weekly != null ? Number(weekly) : null, weeklyResetMs, events, account });
    const lim = fitLimits(loadCalibration({ account }).points);
    console.log(`✓ Saved: at ${point.at}, 5-hour ${point.fivePct ?? "-"}% (logs say $${point.spendFive} in that window), weekly ${point.weeklyPct ?? "-"}% (logs say $${point.spendWeek ?? "?"} this week)`);
    console.log(`Estimated limits so far, in API-equivalent dollars: 5-hour ≈ $${lim.fiveHourUSD?.toFixed(0) ?? "?"}, weekly ≈ $${lim.weeklyUSD?.toFixed(0) ?? "?"}  (${loadCalibration({ account }).points.length} point${loadCalibration().points.length === 1 ? "" : "s"}; add more at different times of day to improve)`);
    return;
  },
  "plan": async (args) => {
  if (args.includes("--app")) {
    const samples = readDesktopPlanSamples();
    if (!samples.length) {
      console.log(`No plan-usage record found from the Claude Desktop app (looked for ${desktopPlanPath()}).`);
      return;
    }
    const last = samples[samples.length - 1];
    const ageH = (Date.now() - last.t) / 3600e3;
    console.log(`\n⚡ PLAN USAGE, AS THE CLAUDE DESKTOP APP RECORDED IT  ${"\x1b[2m"}[the app's own figures; sparse and not live]${"\x1b[0m"}`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`${samples.length} samples from ${new Date(samples[0].t).toISOString().slice(0, 10)} to ${new Date(last.t).toISOString().slice(0, 10)}. The latest, ${ageH < 48 ? `${ageH.toFixed(1)} hours` : `${(ageH / 24).toFixed(1)} days`} ago: 5-hour ${last.fiveHourPct ?? "?"}%, weekly ${last.weeklyPct ?? "?"}%. A sample is written when the app fetches usage, so it can be days old.`);
    const all = replayAll();
    const events = all ? all.results.flatMap((r) => r.timeline.map((/** @type {any} */ e) => ({ t: e.t, cost: e.cost }))) : [];
    const chk = checkAgainstLogs(samples, events);
    console.log(`\nHow close is Sparelimit's estimate from your logs? Each of the ${chk.usable} samples between 15% and 95% was estimated from a limit fitted on the others:`);
    for (const c of chk.checked) console.log(`  ${new Date(c.t).toISOString().slice(0, 16).replace("T", " ")}  app ${String(c.appPct).padStart(3)}%   estimate ${c.estimatePct == null ? "  - " : String(c.estimatePct).padStart(3) + "%"}   ${c.errorPoints == null ? (c.seen ? c.note : "your logs saw no Claude Code use in that window") : (c.errorPoints > 0 ? "+" : "") + c.errorPoints + " points"}`);
    console.log(`Median error ${chk.medianAbsErrorPoints ?? "n/a"} points; ${chk.withinTenPoints} of ${chk.scored} within 10 points. [${chk.confidence}]`);
    console.log(`Use from claude.ai chat and other machines is not in any log Sparelimit reads, which is one reason an estimate can fall short. (Desktop agent-mode sessions are read.)\nTo use these samples as calibration points: sparelimit calibrate --from-app\n${METHOD_FOOTER}\n`);
    return;
  }
    if (args.includes("--accounts")) {
      const settings = loadConfig();
      const dirs = claudeConfigDirs({ extra: settings.accounts.dirs });
      const rows = [];
      for (const dir of dirs) {
        const acct = accountOf(dir, { labels: settings.accounts.labels });
        const ev = await loadRecentEvents({ account: dir });
        const cal = loadCalibration({ account: dir });
        /** @type {any} */
        const e = estimatePlanUsage({ events: ev, calibration: cal });
        rows.push({ dir, acct, est: e, points: cal.points.length, spent5: e.fiveHour?.spentUSD ?? null });
      }
      const calibrated = rows.filter((r) => r.est.fiveHour);
      calibrated.sort((a, b) => a.est.fiveHour.pct - b.est.fiveHour.pct);
      if (args.includes("--json")) {
        const out = (/** @type {any} */ w) => (w ? { pct: Math.round(w.pct), resetsInMin: w.resetsInMin, ratePctPerHour: w.ratePctPerHour, minutesToLimit: w.minutesToLimit, lastsUntilReset: w.lastsUntilReset, basis: w.basis } : null);
        console.log(JSON.stringify({
          accounts: rows.map((r) => ({ label: r.acct.label, plan: r.acct.plan, named: r.acct.named, folder: r.dir.replace(process.env.HOME || "", "~"), calibratedPoints: r.points, fiveHour: out(r.est.fiveHour), weekly: out(r.est.weekly) })),
          mostHeadroom: calibrated.length > 1 ? calibrated[0].acct.label : null,
          nearLimit: calibrated.slice(1).filter((r) => r.est.fiveHour.pct >= 80).map((r) => r.acct.label),
          confidence: "estimated from your logs, per account"
        }, null, 2));
        return;
      }
      console.log(`\n⚡ SPARELIMIT PLAN PLANNER: which account has headroom now ${"\x1b[2m"}[estimated from your logs, per account${"\x1b[0m"}]`);
      console.log(`──────────────────────────────────────────────────────────────`);
      for (const r of rows) {
        const f = r.est.fiveHour;
        const w = r.est.weekly;
        console.log(`${r.acct.label}${r.acct.plan ? `   ${r.acct.plan}` : ""}   (${r.dir.replace(process.env.HOME || "", "~")})`);
        console.log(r.points ? `    ${describeWindow("5-hour", f) || "5-hour: no activity in the current window"}\n    ${describeWindow("weekly", w) || "weekly: give --weekly-reset when calibrating to enable"}   [calibrated on ${r.points} point${r.points === 1 ? "" : "s"}]` : `    not calibrated: sparelimit calibrate --account=${JSON.stringify(r.acct.label)} --five=<%> --weekly=<%>   (the logs show $${r.est.fiveHour?.spentUSD ?? 0} in the current 5-hour window)`);
      }
      if (calibrated.length > 1) {
        const best = calibrated[0];
        console.log(`\nMost headroom now: ${best.acct.label} (5-hour ${Math.round(best.est.fiveHour.pct)}% used, resets in ${best.est.fiveHour.resetsInMin != null ? `${Math.floor(best.est.fiveHour.resetsInMin / 60)}h${String(best.est.fiveHour.resetsInMin % 60).padStart(2, "0")}m` : "?"}).`);
        for (const r of calibrated.slice(1)) if (r.est.fiveHour.pct >= 80) console.log(`Do not switch into ${r.acct.label}: its 5-hour window is ${Math.round(r.est.fiveHour.pct)}% used.`);
      } else if (rows.length === 1) console.log(`\nOne account on this machine, so there is nothing to choose between. Other accounts: give each its own config folder (CLAUDE_CONFIG_DIR=~/.claude-work claude).`);
      console.log(`${"\x1b[2m"}Each account has its own limits and its own calibration. Use of an account from claude.ai chat or another machine is not in any log Sparelimit reads. The Desktop agent-mode sessions count toward the default account (an assumption).${"\x1b[0m"}\n${METHOD_FOOTER}\n`);
      return;
    }
    const account = pickAccount(args);
    const events = await loadRecentEvents({ account });
    const est = estimatePlanUsage({ events, calibration: loadCalibration({ account }) });
    if (!est.limits.fiveHourUSD && !est.limits.weeklyUSD) {
      console.log("No calibration yet. Run once, with the numbers your app shows:\n  sparelimit calibrate --five=60 --weekly=85 --weekly-reset=\"fri 14:00\"");
      return;
    }
    const dim = "\x1b[2m";
    const off = "\x1b[0m";
    console.log(`\n⚡ SPARELIMIT PLAN USAGE (estimated from your own logs) ${dim}[calibrated on ${est.calibratedOn} screenshot${est.calibratedOn === 1 ? "" : "s"}; counts Claude Code on this machine only]${off}`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`5-hour: ${describeWindow("5h", est.fiveHour) || "no activity in the current window"}`);
    console.log(`Weekly: ${describeWindow("7d", est.weekly) || "give --weekly-reset when calibrating to enable"}`);
    console.log(`${dim}Limits used: 5-hour ≈ $${est.limits.fiveHourUSD?.toFixed(0)}, weekly ≈ $${est.limits.weeklyUSD?.toFixed(0) ?? "?"} of API-equivalent usage. Other surfaces (claude.ai chat, Cowork) also use your plan, so the real figure may be higher.${off}\n${METHOD_FOOTER}\n`);
    return;
  },
  "budget": async (args) => {
    const file = configPath();
    const cfg = readJson(file, {}) || {};
    const set = args.slice(1).filter((a) => /^(daily|weekly|monthly)=/.test(a));
    if (args.includes("--clear") || set.length) {
      const next = args.includes("--clear") ? {} : { ...sanitizeBudgets(cfg.budgets) };
      for (const a of set) {
        const [k, v] = a.split("=");
        const n = Number(v);
        if (!(n > 0) || !Number.isFinite(n)) {
          console.error(`"${a}": a budget is a number of dollars above zero.`);
          process.exit(2);
        }
        next[`${k}USD`] = n;
      }
      writeJsonAtomic(file, { ...cfg, budgets: next });
      console.log(`✓ Budgets: ${Object.keys(next).length ? Object.entries(next).map(([k, v]) => `${k.replace("USD", "")} $${v}`).join(", ") : "none"}`);
      if (!args.includes("--check")) return;
    }
    const budgets = loadConfig().budgets;
    const all = replayAll();
    const events = all ? all.results.flatMap((r) => r.timeline.map((/** @type {any} */ e) => ({ t: e.t, cost: e.cost }))) : [];
    const res = checkBudgets(events, budgets);
    if (args.includes("--json")) console.log(JSON.stringify(res, null, 2));
    else {
      console.log(`\n⚡ SPARELIMIT BUDGETS  (API-equivalent dollars at list price [derived]; local calendar: today, the week from Monday, the month from the 1st)`);
      console.log(`──────────────────────────────────────────────────────────────`);
      for (const r of res.rows) console.log(`${r.label.padEnd(11)} $${r.spentUSD.toFixed(2).padStart(9)}   ${r.limitUSD != null ? `of $${r.limitUSD} (${r.pct}%)${r.over ? "   OVER" : ""}` : "no budget set"}`);
      if (!res.anySet) console.log(`\nSet one: sparelimit budget daily=50 weekly=200 monthly=700   (then: sparelimit budget --check)`);
      console.log("");
    }
    if (args.includes("--check") && res.over.length) {
      if (!args.includes("--json")) console.error(`Over budget: ${res.over.join(", ")}.`);
      process.exit(1);
    }
    return;
  },
  "policy": async (args) => {
    const name = args[1] && !args[1].startsWith("-") ? args[1] : null;
    if (name) {
      if (name !== "off" && !(/** @type {Record<string, unknown>} */ (PRESETS))[name]) {
        console.error(`No preset "${name}". Presets: ${Object.keys(PRESETS).join(", ")}, or "off".`);
        process.exit(2);
      }
      const cfg = readJson(configPath(), {}) || {};
      const policy = { ...(cfg.policy || {}) };
      if (name === "off") delete policy.preset;
      else policy.preset = name;
      writeJsonAtomic(configPath(), { ...cfg, policy });
      console.log(`✓ Preset ${name === "off" ? "removed" : name}. Values you set yourself in the config file still win over it.`);
      return;
    }
    const cfg = loadConfig();
    const eff = mergePolicy(cfg.policy);
    console.log(`\n⚡ SPARELIMIT POLICY  (preset: ${cfg.policy.preset || "none"})`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`Presets are starting points (round figures for a kind of day, not measured): tune them against \`sparelimit replay\`.`);
    for (const [id, p] of Object.entries(PRESETS)) console.log(`  ${id.padEnd(12)} ${JSON.stringify(p)}`);
    console.log(`\nIn force: context warn ${eff.context.warnPct}% / stop ${eff.context.blockPct}% · session warn ${eff.budget.sessionWarnUSD != null ? "$" + eff.budget.sessionWarnUSD : "off"} · hourly warn ${eff.budget.hourlyWarnUSD != null ? "$" + eff.budget.hourlyWarnUSD : "off"} / stop ${eff.budget.hourlyBlockUSD != null ? "$" + eff.budget.hourlyBlockUSD : "off"} · weekly pace margin ${eff.quota.weeklyPaceMarginPts != null ? eff.quota.weeklyPaceMarginPts + " points" : "off"}`);
    console.log(`Set one: sparelimit policy agency-day | weekly-pace | steady | off.  A project's .sparelimit/config.json can only make checks stricter (see \`sparelimit method\`).\n`);
    return;
  }
};
