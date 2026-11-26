/**
 * The single-session report and the actions on it: the analysis, the status files, the terminal view, reset, muzzle, freeze, rules, benchmark.
 * Split out of sparelimit.mjs (A11).
 */
import fs from "node:fs";
import { FREEZE } from "./freeze.mjs";
import path from "node:path";
import { STATE_DIR } from "./constants.mjs";
import { buildReport } from "./analyze.mjs";
import { copyToClipboard, notifyDesktop } from "./platform.mjs";
import { describeWindow, planOutlook } from "./plan.mjs";
import { parseTranscript } from "./adapters/index.mjs";
import { redactReport } from "./redact.mjs";

/**
 * Parse any supported transcript (Claude Code, Antigravity) into a normalized session and build the report.
 * `modelOverride` re-prices the whole session as a what-if (those figures become "estimated").
 */
/**
 * @param {string} filePath
 * @param {string | null} [modelOverride]
 */
export function analyzeTranscript(filePath, modelOverride = null) {
  const session = parseTranscript(filePath);
  if (!session) {
    return buildReport({ agent: "unknown", sessionId: path.basename(filePath, ".jsonl"), transcriptPath: filePath, events: [], userTurns: [], commandResults: [], fileTouches: [], raw: {} });
  }
  return buildReport(session, { modelOverride });
}

/**
 * Synchronize state files for HUD, agents, and history
 */
export function syncStatusFiles(/** @type {any} */ fullReport, targetDir = process.cwd()) {
  const report = redactReport(fullReport); // D2: no prompt text in the files

  // 1. Machine-readable agent status file (.sparelimit-status.json)
  const agentStatus = {
    _schema: "sparelimit-agent-protocol-v1",
    timestamp: report.updatedAt,
    sessionId: report.sessionId,
    status: report.flowStatus,
    statusLevel: report.statusLevel,
    should_stop: report.shouldStop,
    pre_action_alert: report.preActionAlert,
    active_context_tokens: report.tokens.latestTurnContext,
    cache_read_ratio_pct: report.tokens.cacheReadRatio,
    accumulated_cost_usd: report.realCostUSD,
    confidence: report.confidence,
    prices_as_of: report.pricesAsOf,
    next_turn_cost_usd: report.nextTurnCostUSD,
    potential_savings_usd: report.potentialSavingsUSD,
    potential_savings_confidence: report.savingsConfidence,
    churned_files: report.reReadFiles.map((/** @type {any} */ f) => `${f.basename} (${f.reads}r/${f.writes}w)`),
    action_required: report.nextAction,
    handoff_prompt: report.handoffPrompt
  };

  // Always keep a copy in the state dir; only touch the project directory if the agent
  // protocol file is already there (opted in via `sparelimit rule --install` or by hand).
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, "status.json"), JSON.stringify(agentStatus, null, 2));
  } catch {}
  try {
    const projectStatus = path.join(targetDir, ".sparelimit-status.json");
    if (fs.existsSync(projectStatus)) fs.writeFileSync(projectStatus, JSON.stringify(agentStatus, null, 2));
  } catch {}

  // 2. Web HUD state files (JSON + JS), served from the state dir by `sparelimit serve`
  try {
    fs.writeFileSync(path.join(STATE_DIR, "live-session.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(
      path.join(STATE_DIR, "live-session.js"),
      `window.__LIVE_SESSION__ = ${JSON.stringify(report, null, 2)};\n`
    );
  } catch {}
}

/**
 * Terminal HUD output
 */
export function printTerminalHUD(/** @type {any} */ report) {
  const c = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    cyan: "\x1b[36m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    bgRed: "\x1b[41m",
    black: "\x1b[30m"
  };

  const statusColor =
    report.statusLevel === "good" ? c.green : report.statusLevel === "warn" ? c.yellow : report.statusLevel === "unknown" ? c.dim : c.red;

  console.log(`\n${c.bold}${c.cyan}⚡ SPARELIMIT — THIS SESSION, LIVE${c.reset}`);
  console.log(
    `${c.dim}Session: ${report.sessionId.slice(0, 8)}… · Model: ${report.modelName} · Turns: ${report.turnCount} · Steps: ${report.modelStepsCount}${c.reset}`
  );
  console.log(`──────────────────────────────────────────────────────────────`);

  if (report.shouldStop) {
    console.log(
      `${c.bgRed}${c.black}${c.bold} PRE-ACTION ALERT ${c.reset} ${c.red}${c.bold}${report.preActionAlert}${c.reset}`
    );
  } else if (report.statusLevel === "warn") {
    console.log(
      `${c.yellow}${c.bold}PRE-ACTION NOTICE:${c.reset} ${c.yellow}${report.preActionAlert}${c.reset}`
    );
  }

  console.log(
    `${c.bold}1. FLOW STATUS:${c.reset}    ${statusColor}${c.bold}${report.flowStatus}${c.reset} (${report.nextAction})`
  );
  console.log(
    `${c.bold}2. REAL ACCUMULATED:${c.reset} ${c.bold}$${report.realCostUSD.toFixed(3)}${c.reset} · ${(report.tokens.total / 1000).toFixed(1)}k tokens (${report.tokens.cacheReadRatio}% cache re-reads) ${c.dim}[${report.confidence}; ${report.modelName}; prices as of ${report.pricesAsOf}]${c.reset}`
  );
  console.log(
    `${c.bold}3. NEXT TURN COST:${c.reset}   ~$${report.nextTurnCostUSD.toFixed(3)}/turn · ${(report.tokens.latestTurnContext / 1000).toFixed(1)}k active context`
  );
  console.log(
    `${c.bold}4. SAVINGS GAIN:${c.reset}     Resetting now saves ~$${report.potentialSavingsUSD.toFixed(2)} over next 10 turns ${c.dim}[estimate]${c.reset}`
  );

  const sr = report.spendRate;
  if (sr) {
    console.log(
      `${c.bold}5. SPEND RATE:${c.reset}       $${sr.costPerActiveHourUSD}/active hour · last ${sr.recent.windowMin} min $${sr.recent.costUSD} ($${sr.recent.costPerHourUSD}/h) · ${sr.costPerTurnUSD != null ? "$" + sr.costPerTurnUSD + "/turn · " : ""}peak hour $${sr.peakHourUSD} · ${sr.activeMinutes} active min${report.fanOut?.subagentResponses ? ` · subagents ${Math.round(report.fanOut.shareOfCost * 100)}% of cost` : ""} ${c.dim}[${report.confidence}]${c.reset}`
    );
  }
  const plan = planOutlook(report.sessionId);
  if (plan && (plan.fiveHour || plan.sevenDay)) {
    const parts = [describeWindow("5h", plan.fiveHour), describeWindow("7d", plan.sevenDay)].filter(Boolean);
    console.log(`${c.bold}6. PLAN LIMITS:${c.reset}      ${parts.join("  |  ")} ${c.dim}[exact, ${plan.ageMin} min ago${plan.account ? `, ${plan.account}` : ""}]${c.reset}`);
  } else {
    console.log(`${c.bold}6. PLAN LIMITS:${c.reset}      ${c.dim}not available for this session — run 'sparelimit init --apply' once so the status-line collector can record your 5-hour and weekly quota${c.reset}`);
  }

  if (report.signals.length > 0) {
    console.log(`${c.bold}7. SIGNALS:${c.reset}          ${report.signals.join(" | ")}`);
  }

  console.log(
    `${c.bold}8. 1-SHOT RESET:${c.reset}     ${c.dim}${report.handoffPrompt.replace(/\n/g, " ")}${c.reset}`
  );
  console.log(`──────────────────────────────────────────────────────────────\n`);
}

/**
 * Desktop notification (macOS, and Linux with notify-send) and a terminal bell
 */
export function notifyOS(/** @type {string} */ title, /** @type {string} */ message) {
  notifyDesktop(title, message, { sound: true });
  process.stdout.write("\x07"); // Terminal bell
}

/**
 * Action: Reset Handoff (Creates .sparelimit-handoff.md and copies to clipboard)
 */
export function executeReset(/** @type {any} */ report) {
  const handoffPath = path.join(process.cwd(), ".sparelimit-handoff.md");
  const content = `# SPARELIMIT HANDOFF PROTOCOL
Generated: ${report.updatedAt}
Session: ${report.sessionId}

## Surgical 1-Shot Prompt (Paste in fresh chat)
\`\`\`markdown
${report.handoffPrompt}
\`\`\`

## Telemetry at Reset
- Final Context: ${(report.tokens.latestTurnContext / 1000).toFixed(1)}k tokens
- Cost Avoided: ~$${report.potentialSavingsUSD.toFixed(2)}
- Touched Files: ${report.touchedFiles.map((/** @type {any} */ f) => f.basename).join(", ")}
`;

  fs.writeFileSync(handoffPath, content);

  if (copyToClipboard(report.handoffPrompt)) console.log(`\n✓ Copied 1-shot handoff prompt to clipboard!`);

  console.log(`✓ Created handoff file: ${handoffPath}`);
  console.log(`\nPaste this directly into your fresh chat:\n\n${report.handoffPrompt}\n`);
}

/**
 * Action: Muzzle raw test and terminal logs (< 15 lines wrapper)
 */
export function executeMuzzle() {
  const scriptPath = path.join(process.cwd(), ".sparelimit-muzzle.sh");
  const muzzleScript = `#!/usr/bin/env bash
# SPARELIMIT LOG MUZZLE
# Wraps verbose test/build commands to output only the failing assertion (< 15 lines).
CMD="$@"
OUTPUT=$($CMD 2>&1)
EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo "✓ Command succeeded."
  exit 0
else
  echo "❌ Command failed with code $EXIT_CODE. Showing compact failure signal only:"
  echo "$OUTPUT" | grep -E -i "(FAIL|Error|AssertionError|TypeError|SyntaxError|expected|received|❯|at )" | grep -v "node_modules" | head -n 15
  exit $EXIT_CODE
fi
`;
  fs.writeFileSync(scriptPath, muzzleScript, { mode: 0o755 });
  console.log(`\n✓ Created log muzzle wrapper: ${scriptPath}`);
  console.log(`Usage with agents: prepend command with ./.sparelimit-muzzle.sh (e.g. ./.sparelimit-muzzle.sh npm test)\n`);
}

/**
 * Action: Freeze touched files list
 */
export function executeFreeze(/** @type {any} */ report, { off = false } = {}) {
  const freezePath = path.join(process.cwd(), ".sparelimit-freeze.json");
  if (off) {
    try {
      fs.unlinkSync(freezePath);
      console.log(`\n✓ Scope freeze lifted.\n`);
    } catch {
      console.log(`\nNo scope freeze here.\n`);
    }
    return;
  }
  const mine = report.touchedFiles.filter((/** @type {any} */ f) => !f.file.includes("/.gemini/") && !f.file.includes("/var/folders/"));
  const rels = mine.map((/** @type {any} */ f) => path.relative(process.cwd(), f.file).split(path.sep).join("/")).filter((/** @type {any} */ r) => r && !r.startsWith(".."));
  const activeFiles = mine.map((/** @type {any} */ f) => f.basename);

  fs.writeFileSync(
    freezePath,
    JSON.stringify(
      {
        _comment: "sparelimit scope freeze. While it lasts, the PreToolUse hook refuses edits to files outside this list. Lift it with `sparelimit freeze --off`; it expires on its own.",
        lockedFiles: activeFiles,
        lockedPaths: rels,
        ttlHours: FREEZE.ttlHours,
        createdAt: new Date().toISOString()
      },
      null,
      2
    )
  );
  console.log(`\n✓ Scope locked for ${FREEZE.ttlHours} hours: ${freezePath}`);
  console.log(`Locked target files: ${(rels.length ? rels : activeFiles).join(", ") || "None"}`);
  console.log(`The hook (sparelimit init --apply) refuses edits to other files. Lift it: sparelimit freeze --off, or sparelimit allow.\n`);
}

/**
 * Action: Print or install Token Shield Rules (.cursorrules / CLAUDE.md)
 */
export function executeRule(install = false) {
  const shieldRules = `# SPARELIMIT TOKEN SHIELD & DOOM-LOOP BREAKER

## 1. PRE-ACTION STATUS CHECK
- Before doing broad multi-file edits, check .sparelimit-status.json if it exists.
- If "should_stop": true, HALT: inform user that context exceeds 75k tokens and suggest starting a fresh session with the provided handoff_prompt.

## 2. SURGICAL CONTEXT & DIFF-ONLY RULES
- Never re-read full files when file path and line numbers are known.
- Output minimal UNIFIED DIFFS only. Never echo full 400-line files to change 3 lines.
- Zero conversational preamble or postamble ("Certainly!", "Here is the updated file...").

## 3. LOG MUZZLE & LOOP PREVENTION
- Never dump raw test/build logs into context. Pipe output or show only the failing assertion (< 15 lines).
- Never rewrite the same file more than 2 times in a session. If a test fails twice, stop and formulate 2 root-cause hypotheses first.
`;

  if (install) {
    const BEGIN = "<!-- sparelimit:begin -->";
    const END = "<!-- sparelimit:end -->";
    const block = `${BEGIN}\n${shieldRules}${END}\n`;
    // Idempotent: replace our marked block in place, otherwise append it once.
    for (const name of [".cursorrules", "CLAUDE.md"]) {
      const target = path.join(process.cwd(), name);
      const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
      const start = existing.indexOf(BEGIN);
      const stop = existing.indexOf(END);
      const next =
        start !== -1 && stop > start
          ? existing.slice(0, start) + block + existing.slice(stop + END.length).replace(/^\n/, "")
          : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${existing ? "\n" : ""}${block}`;
      fs.writeFileSync(target, next);
    }
    // Opt this project in to the agent protocol file the Token Shield tells agents to read.
    const statusFile = path.join(process.cwd(), ".sparelimit-status.json");
    if (!fs.existsSync(statusFile)) fs.writeFileSync(statusFile, "{}\n");
    console.log(`✓ Token Shield installed in .cursorrules and CLAUDE.md (safe to re-run), and opted in to .sparelimit-status.json`);
  } else {
    console.log(`\n${shieldRules}\n`);
    console.log(`Run 'sparelimit rule --install' to append this to .cursorrules and CLAUDE.md in current directory.`);
  }
}

/**
 * Action: Benchmark session vs 10x surgical strike
 */
export function executeBenchmark(/** @type {any} */ report) {
  console.log(`\n${report.sessionId} — EFFICIENCY BENCHMARK`);
  console.log(`──────────────────────────────────────────────────────────────`);
  const actualTokens = report.tokens.total;
  const surgicalEstTokens = Math.max(3000, report.turnCount * 2800);
  const wastedTokens = Math.max(0, actualTokens - surgicalEstTokens);
  const ratio = (actualTokens / surgicalEstTokens).toFixed(1);

  console.log(`Actual Tokens Burned:    ${(actualTokens / 1000).toFixed(1)}k tokens ($${report.realCostUSD.toFixed(3)})`);
  console.log(`Surgical 10x Benchmark:  ${(surgicalEstTokens / 1000).toFixed(1)}k tokens ($${((surgicalEstTokens / 1000000) * report.pricing.input).toFixed(3)})`);
  console.log(`Efficiency Gap:          ${ratio}x difference`);
  console.log(`Wasted History Drag:     ${(wastedTokens / 1000).toFixed(1)}k tokens (${report.tokens.cacheReadRatio}% re-read tax)`);
  console.log(`Potential Net Savings:   ~$${report.potentialSavingsUSD.toFixed(2)}`);
  console.log(`──────────────────────────────────────────────────────────────\n`);
}
