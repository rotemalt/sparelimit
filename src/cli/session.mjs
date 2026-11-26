/** Commands that run around a session: the status line and hook entry points, the installer, the doctor, overrides. Split out of sparelimit.mjs (A11). */
import { noLogsMessage } from "../emptystate.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeSetup, recommend, usedMcpServers } from "../setupweight.mjs";
import { buildSettingsPatch, removeSparelimit } from "../init.mjs";
import { clearLock, readPlanCache, refreshPlanCache } from "../plancache.mjs";
import { discoverTranscripts } from "../transcripts.mjs";
import { execSync } from "node:child_process";
import { handleHook } from "../hook.mjs";
import { handleStatusline } from "../collector.mjs";
import { loadCalibration } from "../planestimate.mjs";
import { loadPricing as loadPricingForHealth, pricingHealth } from "../pricing.mjs";
import { overridePath, probePath, readJson, stateDir, writeJsonAtomic } from "../state.mjs";
import { parseTranscript } from "../adapters/index.mjs";
import { loadConfig } from "../config.mjs";
import { evaluatePlaybooks } from "../playbooks.mjs";

const readStdin = () => {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
};

/** @type {Record<string, (args: string[]) => Promise<void>>} one handler per command; `args` is the whole command line after `sparelimit`, args[0] being the command */
export const commands = {
  "statusline": async (args) => {
    const chain = args.find((a) => a.startsWith("--chain="))?.slice("--chain=".length) || null;
    process.stdout.write(handleStatusline(readStdin(), { chain }) + "\n");
    return;
  },
  "hook": async (args) => {
    let input = {};
    try {
      input = JSON.parse(readStdin() || "{}");
    } catch {}
    const res = handleHook(String(args[1] || "").toLowerCase(), input);
    // exit only after the writes are flushed: on a pipe, process.exit() right after write() can cut a large output short (seen on Node 20 at about 8 KB)
    const flush = (/** @type {NodeJS.WriteStream} */ stream, /** @type {string} */ text) => new Promise((resolve) => (text ? stream.write(text + "\n", () => resolve(undefined)) : resolve(undefined)));
    await flush(process.stdout, res.stdout);
    await flush(process.stderr, res.stderr);
    process.exit(res.exit);
  },
  "probe": async (args) => {
    const id = Math.random().toString(36).slice(2, 6);
    writeJsonAtomic(probePath(), { id, at: new Date().toISOString() });
    console.log(`✓ Probe ${id} armed. Send ANY message in your Claude session now.\n  • A line "[sparelimit] (probe ${id}) ..." in the app means hook messages reach you.\n  • A macOS notification titled "Sparelimit" means the desktop channel works.\n  • The assistant saying "sparelimit probe ${id} received" means the model channel works.\nTell me which of the three you saw.`);
    return;
  },
  "setup": async (args) => {
    const given = args.slice(1).find((a) => !a.startsWith("-"));
    const file = given ? path.resolve(given) : discoverTranscripts(null)[0]?.filePath;
    if (!file) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    const r = /** @type {any} */ (analyzeSetup(file));
    if (!r.available) {
      console.log(r.reason);
      return;
    }
    const k = (/** @type {number} */ n) => `${(n / 1000).toFixed(1)}k`.padStart(7);
    const root = path.join(os.homedir(), ".claude", "projects");
    /** @type {[string, number][]} */
    const recent = [];
    try {
      for (const p of fs.readdirSync(root)) for (const f of fs.readdirSync(path.join(root, p))) if (f.endsWith(".jsonl")) recent.push([path.join(root, p, f), fs.statSync(path.join(root, p, f)).mtimeMs]);
    } catch {}
    const used = usedMcpServers(recent.sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 40).map((x) => x[0]));
    console.log(`\n⚡ SETUP WEIGHT: what every conversation carries before you type a word`);
    console.log(`──────────────────────────────────────────────────────────────`);
    const t = r.tools;
    console.log(`${k(t.tokens)}  Tools (${t.count}): ${t.groups.slice(0, 4).map((/** @type {any} */ g) => `${g.server} ${k(g.tokens).trim()}`).join(" · ")}`);
    console.log(`${k(r.system.reduce((/** @type {number} */ n, /** @type {any} */ s) => n + s.tokens, 0))}  System prompt`);
    const kinds = r.byKind;
    const extra = { "Skills listing": ` (${r.counts.skills} skills)`, "Agent types listing": ` (${r.counts.agentTypes} agent types)`, "Deferred tool names": ` (${r.counts.deferredTools} names)` };
    for (const [kind, n] of Object.entries(kinds)) console.log(`${k(n)}  ${kind}${/** @type {Record<string, string>} */ (extra)[kind] || ""}`);
    for (const f of r.claudeMdFiles) console.log(`         ${f.file}: ${k(f.tokens).trim()} (${f.lines} lines)`);
    console.log(`${k(r.totals.tokens)}  total itemized (sizes ≈ characters ÷ 3.7) [estimated]`);
    if (r.totals.measuredFirstResponseTokens) console.log(`${k(r.totals.measuredFirstResponseTokens)}  measured at the first response (includes your first message and anything the log does not show) [derived]`);
    console.log(`\nCarrying this on every message cost $${r.totals.startCostUSD} of this session's $${r.totals.sessionCostUSD} (${r.totals.shareOfSessionCost}%) over ${r.totals.responses} responses [estimated].`);
    const recs = recommend(r, used);
    console.log(recs.length ? `\nWHAT TO TRIM (largest first):\n${recs.map((x) => `  • ${x.text}`).join("\n")}\n` : `\nNothing obvious to trim from this report.\n`);
    return;
  },
  "__refresh-plan": async (args) => {
    try {
      await refreshPlanCache();
    } finally {
      clearLock();
    }
    return;
  },
  "init": async (args) => {
    const settingsPath = args.includes("--project") ? path.join(process.cwd(), ".claude", "settings.json") : path.join(os.homedir(), ".claude", "settings.json");
    const self = fs.realpathSync(process.argv[1]);
    // Prefer the stable PATH entry (e.g. /opt/homebrew/bin/node) over the version-pinned Cellar path, which breaks on upgrade.
    let nodeBin = process.execPath;
    try {
      const onPath = execSync("command -v node", { encoding: "utf8", shell: "/bin/sh" }).trim();
      if (onPath && fs.realpathSync(onPath) === fs.realpathSync(process.execPath)) nodeBin = onPath;
    } catch {}
    const sparelimitCmd = `${nodeBin} ${self}`;
    const existing = readJson(settingsPath, {});
    if (args.includes("--uninstall")) {
      fs.copyFileSync(settingsPath, `${settingsPath}.sparelimit-backup-${Date.now()}`);
      fs.writeFileSync(settingsPath, JSON.stringify(removeSparelimit(existing), null, 2) + "\n");
      console.log(`✓ Removed sparelimit from ${settingsPath} (backup saved next to it).`);
      return;
    }
    const { settings, notes } = buildSettingsPatch(existing, { sparelimitCmd, chainExisting: args.includes("--chain-existing"), postHooks: args.includes("--post-hooks") });
    console.log(notes.map((n) => `• ${n}`).join("\n"));
    if (!args.includes("--apply")) {
      console.log(`\nDry run. These keys would be written to ${settingsPath}:\n`);
      console.log(JSON.stringify({ statusLine: settings.statusLine, hooks: settings.hooks }, null, 2));
      console.log(`\nApply with: sparelimit init --apply   (a timestamped backup is saved first; undo with: sparelimit init --uninstall)`);
      return;
    }
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    if (fs.existsSync(settingsPath)) fs.copyFileSync(settingsPath, `${settingsPath}.sparelimit-backup-${Date.now()}`);
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
    console.log(`\n✓ Wrote ${settingsPath}. Restart Claude Code sessions to pick it up.`);
    return;
  },
  "allow": async (args) => {
    const minutes = Number(args.find((a) => /^\d+$/.test(a))) || 30;
    const session = args.find((a) => a.startsWith("--session="))?.slice("--session=".length);
    const until = Date.now() + minutes * 60e3;
    const ov = readJson(overridePath(), {});
    if (session) ov.sessions = { ...(ov.sessions || {}), [session]: until };
    else ov.all = until;
    writeJsonAtomic(overridePath(), ov);
    console.log(`✓ Hard stops downgraded to warnings for ${minutes} min${session ? ` (session ${session})` : ""}.`);
    return;
  },
  "playbooks": async (args) => {
    if (args[1] === "example") {
      console.log(JSON.stringify({ playbooks: { enabled: true, dryRun: true, rules: [{ id: "five-hour-short", when: "five-hour-runs-out", atPct: 50, do: ["warn", "handoff", "other-account"] }, { id: "big-context", when: "context-pct", atPct: 70, do: ["warn", "handoff", "cheaper-model"] }] } }, null, 2));
      console.error("Put this under the top level of ~/.sparelimit/config.json (your own file; a project file cannot change playbooks). dryRun logs what a rule would say and shows it to nobody; set it to false to let the rules speak.");
      return;
    }
    const pb = loadConfig().playbooks;
    console.log(`\nPLAYBOOKS: your own rules for warnings and suggestions (${pb.enabled ? (pb.dryRun ? "on, dry run: logged, shown to nobody" : "on") : "off"})`);
    if (!pb.rules.length) console.log(`No valid rules. \`sparelimit playbooks example\` prints a starting point.`);
    for (const r of pb.rules) console.log(`  ${r.id}: when ${r.when}${r.atPct != null ? ` ${r.atPct}%` : ""}${r.atUSD != null ? ` $${r.atUSD}` : ""} → ${r.do.join(", ")}`);
    // what they say about the freshest session snapshot, whether or not they are switched on
    const live = path.join(stateDir(), "live");
    const snaps = fs.existsSync(live) ? fs.readdirSync(live).filter((f) => f.endsWith(".json")).map((f) => ({ f, m: fs.statSync(path.join(live, f)).mtimeMs })).sort((a, b) => b.m - a.m) : [];
    if (!snaps.length) {
      console.log(`\nNo session snapshot yet (the status line has not reported), so there is nothing to test the rules against.`);
      return;
    }
    const snap = readJson(path.join(live, snaps[0].f), {});
    const hits = evaluatePlaybooks({ snapshot: snap, config: { ...pb, enabled: true } });
    console.log(`\nAgainst the latest session (${Math.round((Date.now() - snaps[0].m) / 60e3)} min ago): ${hits.length ? "" : "no rule matches."}`);
    for (const h of hits) console.log(`  ${h.message}`);
    return;
  },
  "doctor": async (args) => {
    const ok = (/** @type {any} */ b) => (b ? "✔" : "✘");
    let settings = {};
    try {
      settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8"));
    } catch {}
    const installed = JSON.stringify(settings).includes("sparelimit-managed");
    {
      const recent = discoverTranscripts(null, { global: true }).filter((t) => t.mtimeMs > Date.now() - 14 * 86400e3 && t.filePath.includes(`${path.sep}.claude${path.sep}`));
      const used = new Set();
      for (const t of recent) for (const e of parseTranscript(t.filePath)?.events || []) if (e.model) used.add(e.model);
      const h = pricingHealth(loadPricingForHealth(), { used: [...used] });
      let cacheN = 0;
      let cacheBytes = 0;
      try {
        for (const f of fs.readdirSync(path.join(stateDir(), "replay-cache"))) {
          cacheN += 1;
          cacheBytes += fs.statSync(path.join(stateDir(), "replay-cache", f)).size;
        }
      } catch {}
      console.log(`${ok(true)} replay cache: ${cacheN} sessions, ${(cacheBytes / 1e6).toFixed(1)} MB (the views over all sessions read what changed; delete the folder or set SPARELIMIT_NO_CACHE=1 to turn it off)`);
      console.log(`${ok(!h.stale)} price snapshot is ${h.ageDays == null ? "of unknown age" : `${h.ageDays} days old`}${h.stale ? "  → run: npm run update-pricing" : ""}`);
      for (const d of h.deprecated) console.log(`${d.past ? "✘" : "!"} ${d.model} (used in the last 14 days) ${d.past ? `was retired on ${d.date}` : `is retired on ${d.date}, in ${d.daysLeft} days`}; Sparelimit still prices it`);
    }
    const live = path.join(stateDir(), "live");
    const snaps = fs.existsSync(live) ? fs.readdirSync(live).filter((f) => f.endsWith(".json")) : [];
    const newest = snaps.map((f) => fs.statSync(path.join(live, f)).mtimeMs).sort((a, b) => b - a)[0];
    const stateD = path.join(stateDir(), "state");
    const hookNewest = fs.existsSync(stateD) ? fs.readdirSync(stateD).map((f) => fs.statSync(path.join(stateD, f)).mtimeMs).sort((a, b) => b - a)[0] : null;
    const quotaLog = path.join(stateDir(), "quota-log.jsonl");
    const quotaRows = fs.existsSync(quotaLog) ? fs.readFileSync(quotaLog, "utf8").split("\n").filter(Boolean).length : 0;
    const cal = loadCalibration();
    const ago = (/** @type {any} */ ms) => (ms ? `${Math.round((Date.now() - ms) / 60e3)} min ago` : "never");
    console.log(`\nsparelimit doctor`);
    console.log(`${ok(installed)} installed in Claude Code settings (status line + hooks)${installed ? "" : "  → run: sparelimit init --apply"}`);
    console.log(`${ok(hookNewest)} hooks have run (last: ${ago(hookNewest)})${hookNewest ? "" : "  → start a new Claude Code session after installing"}`);
    console.log(`${ok(snaps.length)} status line has reported (${snaps.length} session${snaps.length === 1 ? "" : "s"}, last: ${ago(newest)})`);
    if (!snaps.length) console.log(`   The status line runs in the terminal version of Claude Code, but not (so far) in the Desktop app. For exact 5-hour and weekly numbers, run Claude Code in a terminal.\n   Meanwhile: sparelimit calibrate / sparelimit plan estimate it from your logs.`);
    console.log(`${ok(quotaRows)} plan-limit history rows recorded: ${quotaRows}`);
    const pc = readPlanCache();
    console.log(`${ok(pc)} plan-usage cache for hooks (${pc ? `${Object.keys(pc.files).length} sessions, refreshed ${ago(pc.computedAt)}` : "not built yet: run sparelimit plan once"})`);
    console.log(`${ok(cal.points.length)} calibration points: ${cal.points.length}${cal.points.length ? "" : "  → sparelimit calibrate --five=<%> --weekly=<%> --weekly-reset=\"fri 14:00\""}`);
    console.log("");
    return;
  }
};
