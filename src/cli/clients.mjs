/** Commands about clients, accounts and the other agents (Codex CLI): report, clients, accounts, codex. Split out of analysis.mjs (A11). */
import { loadConfig, sanitizeAccounts } from "../config.mjs";
import { checkBudgets } from "../budget.mjs";
import { checkClientBudgets, clientEvents, sanitizeClients, summarizeClients } from "../clients.mjs";
import { buildClientReport, renderClientReportHtml } from "../clientreport.mjs";
import { claudeConfigDirs, summarizeAccounts } from "../accounts.mjs";
import { describeWindow } from "../plan.mjs";
import fs from "node:fs";
import path from "node:path";
import { METHOD_FOOTER } from "../constants.mjs";
import os from "node:os";
import { configPath, readJson, stateDir, writeJsonAtomic } from "../state.mjs";
import { clearClientBudgetLock, writeClientBudgets } from "../clientalert.mjs";
import { codexSessionFiles, geminiSessionFiles, isClaudeLog } from "../sources.mjs";
import { discoverTranscripts, replayAll } from "../transcripts.mjs";
import { buildDeviceFile, mergeDevices, readDeviceFiles, thisDevice, writeDeviceFile } from "../sync.mjs";
import { loadPricing as loadPricingForHealth } from "../pricing.mjs";
import { parseTranscript } from "../adapters/index.mjs";
import { summarizeCodex } from "../codexreport.mjs";

/** The sessions of the agents other than Claude Code that are priced into client views (Codex CLI, Gemini CLI). */
const otherAgentSessions = () => [...codexSessionFiles(), ...geminiSessionFiles()].map((f) => parseTranscript(f)).filter((x) => x && (x.agent === "codex" || x.agent === "gemini"));

/** @type {Record<string, (args: string[]) => Promise<void>>} */
export const commands = {
  "report": async (args) => {
    // `--client=Acme` and `--client Acme` both work
    const arg = (/** @type {string} */ k) => {
      const eq = args.find((a) => a.startsWith(`--${k}=`));
      if (eq) return eq.slice(k.length + 3);
      const i = args.indexOf(`--${k}`);
      return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
    };
    const client = arg("client");
    const settings = loadConfig();
    const known = [...new Set(settings.clients.rules.map((r) => r.label))];
    if (!client || !known.includes(client)) {
      console.error(client ? `No client "${client}". Clients with rules: ${known.join(", ") || "none"}.` : "Usage: sparelimit report --client \"Acme\" [--days=30] [--hide-projects] [--with-budget] [--out=dir] [--json]");
      if (!known.length) console.error('Write a rule first: sparelimit clients add --contains=acme "Acme"');
      process.exit(2);
    }
    const days = Math.min(365, Math.max(1, Number(arg("days")) || 30));
    const all = replayAll();
    const codexSessions = otherAgentSessions();
    let budget = null;
    if (args.includes("--with-budget")) {
      // the client's own budgets (daily, weekly, monthly) against their spend, shown only when you ask: a budget is often an internal number
      const chk = checkClientBudgets(clientEvents({ claudeResults: all ? all.results : [], codexSessions, rules: settings.clients.rules, pricing: loadPricingForHealth() }), settings.clients.budgets);
      budget = chk.clients.find((c) => c.label === client)?.rows || null;
    }
    const rep = buildClientReport({ claudeResults: all ? all.results : [], codexSessions, rules: settings.clients.rules, client, days, pricing: loadPricingForHealth(), hideProjects: args.includes("--hide-projects"), budget });
    if (args.includes("--json")) {
      console.log(JSON.stringify(rep, null, 2));
      return;
    }
    const dir = path.resolve(arg("out") || process.cwd());
    fs.mkdirSync(dir, { recursive: true });
    const slug = client.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
    const file = path.join(dir, `sparelimit-report-${slug}.html`);
    fs.writeFileSync(file, renderClientReportHtml(rep));
    console.log(`✓ Wrote ${file}`);
    console.log(`${client}: $${rep.totalUSD.toLocaleString("en-US", { minimumFractionDigits: 2 })} at list price over ${rep.periodDays} days, ${rep.sessions} sessions, ${rep.projects} projects. Open it in a browser and print to PDF to send it.`);
    console.log(`It holds no prompts and no file paths.${rep.hideProjects ? " Project names are left out." : " Add --hide-projects to leave project names out."}`);
  },
  "clients": async (args) => {
    const cfgFile = configPath();
    if (args[1] === "add") {
      const contains = args.find((a) => a.startsWith("--contains="))?.slice("--contains=".length);
      const rest = args.slice(2).filter((a) => !a.startsWith("--contains="));
      const target = contains ? null : rest[0];
      const label = (contains ? rest : rest.slice(1)).join(" ").trim();
      const rule = contains ? { contains, label } : { path: target, label };
      if (sanitizeClients({ rules: [rule] }).rules.length !== 1) {
        console.error('Usage: sparelimit clients add /absolute/path "Client name"   or   sparelimit clients add --contains=text "Client name"\n(a path must be absolute, text at least 2 characters, a name 1 to 60)');
        process.exit(2);
      }
      const cfg = readJson(cfgFile, {}) || {};
      const cur = sanitizeClients(cfg.clients).rules;
      writeJsonAtomic(cfgFile, { ...cfg, clients: { ...(cfg.clients || {}), rules: [...cur, sanitizeClients({ rules: [rule] }).rules[0]] } }); // other client settings (budgets) are kept
      console.log(`✓ Rule ${cur.length + 1}: ${rule.path ? rule.path : `names containing "${rule.contains}"`} → ${rule.label}`);
      return;
    }
    if (args[1] === "budget") {
      const name = args[2];
      const sets = args.slice(3).filter((a) => /^(daily|weekly|monthly)=/.test(a));
      const cfg = readJson(cfgFile, {}) || {};
      const known = [...new Set(sanitizeClients(cfg.clients).rules.map((r) => r.label))];
      if (!name || !known.includes(name) || (!sets.length && !args.includes("--clear"))) {
        console.error(`Usage: sparelimit clients budget "Client name" daily=20 weekly=100 monthly=400   (or --clear)\nClients with rules: ${known.join(", ") || "none. Write a rule first: sparelimit clients add --contains=acme \"Acme\""}`);
        process.exit(2);
      }
      const budgets = sanitizeClients(cfg.clients).budgets;
      if (args.includes("--clear")) delete budgets[name];
      else {
        const next = { ...(budgets[name] || {}) };
        for (const a of sets) {
          const [k, v] = a.split("=");
          const n = Number(v);
          if (!(n > 0) || !Number.isFinite(n)) {
            console.error(`"${a}": a budget is a number of dollars above zero.`);
            process.exit(2);
          }
          next[`${k}USD`] = n;
        }
        budgets[name] = next;
      }
      writeJsonAtomic(cfgFile, { ...cfg, clients: { ...(cfg.clients || {}), budgets } });
      console.log(`✓ ${name}: ${budgets[name] ? Object.entries(budgets[name]).map(([k, v]) => `${k.replace("USD", "")} $${v}`).join(", ") : "no budget"}`);
      return;
    }
    const settings = loadConfig();
    const all = replayAll();
    if (args.includes("--check")) {
      const codexSessions = otherAgentSessions();
      const chk = checkClientBudgets(clientEvents({ claudeResults: all ? all.results : [], codexSessions, rules: settings.clients.rules, pricing: loadPricingForHealth() }), settings.clients.budgets);
      if (args.includes("--json")) console.log(JSON.stringify(chk, null, 2));
      else {
        const usd = (/** @type {number} */ n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        console.log(`\n⚡ SPARELIMIT CLIENT BUDGETS  (API-equivalent dollars at list price [derived]; local calendar)`);
        console.log(`──────────────────────────────────────────────────────────────`);
        if (!chk.clients.length) console.log(`No client budgets set. sparelimit clients budget "Acme" monthly=400`);
        for (const c of chk.clients) for (const r of c.rows) console.log(`${c.label.padEnd(26)} ${r.period.padEnd(11)} ${usd(r.spentUSD).padStart(11)} of ${usd(r.limitUSD)} (${r.pct}%)${r.over ? "   OVER" : ""}`);
        console.log("");
      }
      if (chk.overAny) {
        if (!args.includes("--json")) console.error(`Over budget: ${chk.clients.filter((c) => c.over.length).map((c) => `${c.label} (${c.over.join(", ")})`).join("; ")}.`);
        process.exit(1);
      }
      return;
    }
    const sum = summarizeClients(all ? all.results : [], settings.clients.rules);
    if (args.includes("--json")) {
      console.log(JSON.stringify(sum, null, 2));
      return;
    }
    const usd = (/** @type {number} */ n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    console.log(`\n⚡ SPARELIMIT CLIENTS: spend by client`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`${sum.rules} rule${sum.rules === 1 ? "" : "s"}.\n`);
    for (const c of sum.clients) console.log(`${c.label.padEnd(28)} ${usd(c.totalUSD).padStart(11)} in total · ${usd(c.last30DaysUSD)} in 30 days · ${usd(c.last7DaysUSD)} in 7 days · ${c.sessions} sessions in ${c.projects} projects [derived]`);
    if (sum.unassignedTop.length) {
      console.log(`\nLargest unassigned projects (write a rule for these):`);
      for (const u of sum.unassignedTop) console.log(`  ${usd(u.usd).padStart(10)}  ${u.project}`);
    }
    console.log(`\nAdd a rule: sparelimit clients add /absolute/path "Client name"   or   sparelimit clients add --contains=text "Client name"\n${sum.note}\n${METHOD_FOOTER}\n`);
  },
  "accounts": async (args) => {
    const cfgFile = configPath();
    const sub = args[1];
    if (sub === "label" || sub === "add-dir") {
      const target = args[2];
      if (!target) {
        console.error(sub === "label" ? "Usage: sparelimit accounts label <config folder or account id> <name>" : "Usage: sparelimit accounts add-dir <absolute path of a Claude config folder>");
        process.exit(2);
      }
      const cfg = readJson(cfgFile, {}) || {};
      /** @type {{ dirs: string[], labels: Record<string, string> }} */
      const acc = sanitizeAccounts(cfg.accounts);
      if (sub === "add-dir") {
        if (!path.isAbsolute(target) || !fs.existsSync(path.join(target, "projects"))) {
          console.error(`${target} is not an absolute path to a Claude config folder (one with a "projects" folder inside).`);
          process.exit(2);
        }
        acc.dirs = [...new Set([...acc.dirs, path.resolve(target)])];
        console.log(`✓ Added ${path.resolve(target)}.`);
      } else {
        const name = args.slice(3).join(" ").trim();
        if (!name || name.length > 60) {
          console.error("Give the account a name of 1 to 60 characters.");
          process.exit(2);
        }
        acc.labels[target] = name;
        console.log(`✓ ${target} is now called "${name}".`);
      }
      writeJsonAtomic(cfgFile, { ...cfg, accounts: acc });
      return;
    }
    const all = replayAll();
    const settings = loadConfig();
    const dirs = claudeConfigDirs({ extra: settings.accounts.dirs });
    const sum = summarizeAccounts(all ? all.results : [], dirs, { labels: settings.accounts.labels });
    if (args.includes("--json")) {
      console.log(JSON.stringify(sum, null, 2));
      return;
    }
    const usd = (/** @type {number} */ n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const home = os.homedir();
    console.log(`\n⚡ SPARELIMIT ACCOUNTS: spend by Claude account on this machine`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`${sum.configDirs} Claude config folder${sum.configDirs === 1 ? "" : "s"} found.\n`);
    for (const a of sum.accounts) {
      console.log(`${a.label}${a.named ? "  (named by you)" : ""}${a.plan ? `   ${a.plan}` : ""}`);
      console.log(`    ${a.sessions} sessions · ${usd(a.totalUSD)} in total · ${usd(a.last7DaysUSD)} in the last 7 days · last active ${a.lastActive ? a.lastActive.slice(0, 10) : "never"} [derived]`);
      console.log(`    ${a.configDir ? a.configDir.replace(home, "~") : a.note || ""}`);
    }
    if (sum.configDirs === 1) console.log(`\nOnly one config folder, so one account. If you use several, give each its own folder (CLAUDE_CONFIG_DIR=~/.claude-work claude) or add one: sparelimit accounts add-dir /absolute/path`);
    console.log(`Name an account: sparelimit accounts label <folder or id> "Client A"\n${sum.note}\n${METHOD_FOOTER}\n`);
  },
  "sync": async (args) => {
    // `--dir=/path` and `--dir /path` both work; the folder is remembered after the first run
    const arg = (/** @type {string} */ k) => {
      const eq = args.find((a) => a.startsWith(`--${k}=`));
      if (eq) return eq.slice(k.length + 3);
      const i = args.indexOf(`--${k}`);
      return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
    };
    const memo = path.join(stateDir(), "sync.json");
    const dirArg = arg("dir") || readJson(memo, {})?.dir;
    if (!dirArg) {
      console.error('Usage: sparelimit sync --dir <folder> [--name="Laptop"] [--days=30] [--json]\nThe folder is one your devices already share (iCloud Drive, Dropbox, Syncthing, a private git repository). Sparelimit writes one small file of totals into it and reads the other devices\' files; it sends nothing itself.');
      process.exit(2);
    }
    const dir = path.resolve(dirArg.replace(/^~(?=$|[\\/])/, os.homedir()));
    const days = Math.min(365, Math.max(1, Number(arg("days")) || 30));
    const settings = loadConfig();
    const dirs = claudeConfigDirs({ extra: settings.accounts.dirs });
    const sessions = [];
    for (const t of discoverTranscripts(undefined, { global: true })) {
      if (!isClaudeLog(t.filePath)) continue;
      const session = parseTranscript(t.filePath);
      if (session && session.agent === "claude-code") sessions.push({ filePath: t.filePath, session });
    }
    const device = thisDevice({ name: arg("name") });
    const mine = buildDeviceFile(sessions, { pricing: loadPricingForHealth(), dirs, labels: settings.accounts.labels, device });
    const written = writeDeviceFile(dir, mine);
    writeJsonAtomic(memo, { dir });
    const { devices, skipped } = readDeviceFiles(dir);
    const view = mergeDevices(devices, { days });
    if (args.includes("--json")) {
      console.log(JSON.stringify({ folder: dir, wrote: written, ...view, skipped }, null, 2));
      return;
    }
    const usd = (/** @type {number} */ n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    console.log(`\n⚡ SPARELIMIT SYNC: one view across your devices`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`Wrote ${written.replace(os.homedir(), "~")} (${mine.rows.length} rows of totals: no prompts, file paths or code).`);
    console.log(`${view.devices.length} device${view.devices.length === 1 ? "" : "s"} in the folder, last ${days} days: ${usd(view.totalUSD)} at list price [derived]\n`);
    for (const d of view.devices) console.log(`  ${d.name.padEnd(24)} ${usd(d.usd).padStart(11)}   last day ${d.lastDay || "none"}${d.id === device.id ? "   (this device)" : `   updated ${d.updatedAt ? d.updatedAt.slice(0, 16).replace("T", " ") + " UTC" : "unknown"}`}`);
    if (view.accounts.length) {
      console.log(`\nBy account (the same account on two devices is one row):`);
      for (const a of view.accounts) console.log(`  ${a.label.slice(0, 24).padEnd(24)} ${usd(a.usd).padStart(11)}`);
    }
    const recent = view.daily.slice(-7);
    if (recent.length) {
      console.log(`\nLast ${recent.length} days with use (UTC):`);
      for (const d of recent) console.log(`  ${d.day}  ${usd(d.usd).padStart(11)}`);
    }
    for (const s of skipped) console.log(`\nskipped ${s.file}: ${s.reason}`);
    if (view.devices.length === 1) console.log(`\nOnly this device so far. Run \`sparelimit sync --dir ${dirArg}\` on your other machine, pointing at the same shared folder.`);
    console.log(`${view.note}\n${METHOD_FOOTER}\n`);
  },
  "codex": async (args) => {
    const files = codexSessionFiles();
    if (!files.length) {
      console.error("No Codex sessions found in ~/.codex/sessions (set CODEX_HOME if yours are elsewhere).");
      process.exit(1);
    }
    const sessions = files.map((f) => parseTranscript(f)).filter((x) => x && x.agent === "codex");
    const sum = summarizeCodex(sessions, { pricing: loadPricingForHealth() });
    if (args.includes("--json")) {
      console.log(JSON.stringify(sum, null, 2));
      return;
    }
    const usd = (/** @type {number} */ n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const m = (/** @type {number} */ n) => `${(n / 1e6).toFixed(1)}M`;
    console.log(`\n⚡ SPARELIMIT CODEX: what your Codex sessions cost`);
    console.log(`──────────────────────────────────────────────────────────────`);
    console.log(`${sum.conversations} conversations and ${sum.fanOut.subagentSessions} subagent runs · ${sum.responses.toLocaleString("en-US")} responses · ${usd(sum.totalUSD)} at list price [${sum.confidence}]`);
  if (sum.fanOut.subagentSessions) console.log(`Subagent runs cost ${usd(sum.fanOut.subagentUSD)} (${sum.fanOut.shareOfSpend}% of the spend), a median of ${usd(sum.fanOut.medianSubagentUSD)} each${sum.fanOut.widest ? `; the widest fan-out was ${sum.fanOut.widest.subagents} subagents (${usd(sum.fanOut.widest.subagentUSD)}) in ${sum.fanOut.widest.project || "one conversation"}` : ""} [derived]`);
  console.log(`Tokens: ${m(sum.tokens.total)} in total, ${sum.tokens.cacheReadShare}% of them cache re-reads [exact, as the log reports them]`);
    if (sum.planLimits && (sum.planLimits.fiveHourPct != null || sum.planLimits.weeklyPct != null)) {
    const ageH = (Date.now() - Date.parse(sum.planLimits.at)) / 3600e3;
    console.log(`Plan limits as Codex last reported them, ${ageH < 48 ? `${ageH.toFixed(1)} hours` : `${(ageH / 24).toFixed(1)} days`} ago: 5-hour ${sum.planLimits.fiveHourPct ?? "?"}%, weekly ${sum.planLimits.weeklyPct ?? "?"}% [${sum.planLimits.confidence}; not live]`);
    const f = sum.planLimits.forecast;
    if (f?.windowResetSinceReading) console.log(`  A limit window has reset since that reading, so there is no current figure to forecast from.`);
    else if (f && (f.fiveHour || f.weekly)) {
      for (const [label, w] of [["5-hour", f.fiveHour], ["weekly", f.weekly]]) if (w) console.log(`  ${describeWindow(label, w)}${w.basis === "window average" ? " (at the average pace of the window)" : w.basis === "too early in the window to project" ? " (too early in the window to project)" : ""} [estimated]`);
      if (f.ageMin > 30) console.log(`  The reading is ${f.ageMin} minutes old, so the pace is the window average, not the recent pace.`);
    }
  }
  console.log(`\nBY MODEL`);
    for (const x of sum.byModel) console.log(`  ${usd(x.usd).padStart(10)}  ${x.model}  (${x.responses.toLocaleString("en-US")} responses)${x.priced ? "" : "  [not in the price list: default price, estimated]"}`);
    console.log(`\nLAST 14 DAYS`);
    for (const d of sum.last14Days) console.log(`  ${d.day}  ${usd(d.usd).padStart(9)}`);
    console.log(`\nLARGEST CONVERSATIONS (subagents included)`);
    for (const t of sum.top) console.log(`  ${usd(t.totalUSD).padStart(10)}  ${String(t.id).slice(0, 8)}…  ${t.project || ""}${t.subagents ? `  (+${t.subagents} subagents, ${usd(t.subagentUSD)})` : ""}`);
    console.log(`\nThe coaching views (when to reset, cold-cache returns, which model) are not applied to Codex: their rules are Claude's.\n${METHOD_FOOTER}\n`);
    return;
  },
  "__refresh-client-budgets": async (args) => {
    try {
      // the cache is shared by every project, so it is built from the global config only (a project's own budgets are not cached)
      const settings = loadConfig({ cwd: null });
      if (Object.keys(settings.clients.budgets).length || Object.keys(settings.budgets).length) {
        const all = replayAll();
        const codexSessions = otherAgentSessions();
        const clientCheck = Object.keys(settings.clients.budgets).length ? checkClientBudgets(clientEvents({ claudeResults: all ? all.results : [], codexSessions, rules: settings.clients.rules, pricing: loadPricingForHealth() }), settings.clients.budgets) : { clients: [] };
        const overall = Object.keys(settings.budgets).length ? checkBudgets(all ? all.results.flatMap((r) => r.timeline.map((/** @type {{ t: number, cost: number }} */ e) => ({ t: e.t, cost: e.cost }))) : [], settings.budgets) : null;
        writeClientBudgets(clientCheck, Date.now(), overall);
      }
    } finally {
      clearClientBudgetLock();
    }
    return;
  },
};
