#!/usr/bin/env node
/**
 * ⚡ SPARELIMIT — ZERO-DEPENDENCY AI CODING TELEMETRY & DOOM-LOOP GUARDRAIL
 * Passive local observer, MCP server, pre-action risk analyzer, and 1-shot handoff engine.
 */




// Runtime state (live snapshots read by the dashboard) lives here, never in the install dir or git.























// CLI Execution Router
import { noLogsMessage } from "./src/emptystate.mjs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { planOutlook } from "./src/plan.mjs";
import { redactReport } from "./src/redact.mjs";
import { discoverTranscripts, replayAll, computeHabitCard, listClaudeSessions, timelineFor, readAuditRows, computeDigest } from "./src/transcripts.mjs";
import { analyzeTranscript, syncStatusFiles, printTerminalHUD, executeReset, executeMuzzle, executeFreeze, executeRule, executeBenchmark } from "./src/report.mjs";
import { startWatcher, startMcpServer } from "./src/mcp.mjs";
import { startServer } from "./src/server.mjs";
import { VERSION, STATE_DIR } from "./src/constants.mjs";
import { commands as sessionCommands } from "./src/cli/session.mjs";
import { commands as planCommands } from "./src/cli/plan.mjs";
import { commands as analysisCommands } from "./src/cli/analysis.mjs";
import { commands as usageCommands } from "./src/cli/usage.mjs";
import { commands as clientCommands } from "./src/cli/clients.mjs";
import { commands as helpCommands, helpText } from "./src/cli/help.mjs";
import { commands as shareCommands } from "./src/cli/share.mjs";
import { commands as countCommands } from "./src/cli/count.mjs";

// The functions that used to live here are re-exported so `import ... from "./sparelimit.mjs"` keeps working (tests, tools).
export { VERSION, STATE_DIR } from "./src/constants.mjs";
export { claudeProjectDirName, discoverTranscripts, replayAll, computeHabitCard, listClaudeSessions, timelineFor, readAuditRows, computeDigest } from "./src/transcripts.mjs";
export { analyzeTranscript, syncStatusFiles, printTerminalHUD, executeReset, executeMuzzle, executeFreeze, executeRule, executeBenchmark } from "./src/report.mjs";
export { startWatcher, startMcpServer } from "./src/mcp.mjs";
export { startServer } from "./src/server.mjs";


async function main() {
const args = process.argv.slice(2);
const command = args[0] || "hud";

// The commands that read no transcript live in src/cli/*.mjs, one handler each.
const handler = { ...sessionCommands, ...planCommands, ...analysisCommands, ...usageCommands, ...clientCommands, ...shareCommands, ...countCommands, ...helpCommands }[command];
if (handler) {
  await handler(args);
  return;
}

// A word that is no command and no file is a typo: say so instead of silently showing the live view.
const TRANSCRIPT_COMMANDS = ["hud", "watch", "serve", "mcp", "reset", "act", "muzzle", "freeze", "rule", "bench", "benchmark", "status"];
if (!command.startsWith("-") && !TRANSCRIPT_COMMANDS.includes(command) && !fs.existsSync(command)) {
  console.error(`sparelimit: no command called "${command}".\n\n${helpText(false)}`);
  process.exit(1);
}

const modelFlag = args.find((a) => a.startsWith("--model="))?.split("=")[1] || null;
const customPath = args.find((a) => !a.startsWith("-") && a !== command);
const globalScope = args.includes("--global");

const discovered = discoverTranscripts(customPath, { global: globalScope });
const activeTranscript = discovered.length > 0 ? discovered[0].filePath : null;
if (customPath && !activeTranscript) {
  console.error(`Transcript not found: ${customPath}`);
  process.exit(1);
}
if (activeTranscript && !customPath && !discovered[0].projectMatch && !globalScope && command !== "mcp" && command !== "rule" && command !== "muzzle") {
  console.error(`note: no transcript found for this project (${process.cwd()}); showing the most recent one on this machine. Use --global to silence.`);
}

switch (command) {
  case "watch":
    startWatcher(customPath, modelFlag);
    break;

  case "serve":
    startServer(customPath, modelFlag, 4321);
    break;

  case "mcp":
    startMcpServer(customPath, modelFlag);
    break;

  case "act": // one short word for the same thing as `sparelimit reset`: act on the alert you just saw
  case "reset":
    if (!activeTranscript) {
      console.error("No active agent transcript found.");
      process.exit(1);
    }
    executeReset(analyzeTranscript(activeTranscript, modelFlag));
    break;

  case "muzzle":
    executeMuzzle();
    break;

  case "freeze":
    if (args.includes("--off")) {
      executeFreeze(null, { off: true });
      break;
    }
    if (!activeTranscript) {
      console.error("No active agent transcript found.");
      process.exit(1);
    }
    executeFreeze(analyzeTranscript(activeTranscript, modelFlag));
    break;

  case "rule":
    executeRule(args.includes("--install"));
    break;

  case "bench":
  case "benchmark":
    if (!activeTranscript) {
      console.error("No active agent transcript found.");
      process.exit(1);
    }
    executeBenchmark(analyzeTranscript(activeTranscript, modelFlag));
    break;

  case "status":
    if (args.includes("--json")) {
      if (!activeTranscript) {
        console.log(JSON.stringify({ status: "UNKNOWN", error: "No transcript found" }));
        process.exit(0);
      }
      const report = analyzeTranscript(activeTranscript, modelFlag);
      syncStatusFiles(report);
      console.log(
        JSON.stringify(
          {
            status: report.flowStatus,
            statusLevel: report.statusLevel,
            should_stop: report.shouldStop,
            pre_action_alert: report.preActionAlert,
            active_context_tokens: report.tokens.latestTurnContext,
            accumulated_cost_usd: report.realCostUSD,
            confidence: report.confidence,
            spend_rate: report.spendRate,
            fan_out: report.fanOut,
            plan_limits: planOutlook(report.sessionId),
            dedup_unique_responses: report.dedup.uniqueResponses,
            next_turn_cost_usd: report.nextTurnCostUSD,
            potential_savings_usd: report.potentialSavingsUSD,
            churned_files: report.reReadFiles.map((f) => `${f.basename} (${f.reads}r/${f.writes}w)`),
            action_required: report.nextAction,
            handoff_prompt: redactReport(report).handoffPrompt
          },
          null,
          2
        )
      );
    } else {
      if (!activeTranscript) {
        console.error(noLogsMessage());
        process.exit(1);
      }
      const report = analyzeTranscript(activeTranscript, modelFlag);
      syncStatusFiles(report);
      printTerminalHUD(report);
    }
    break;

  default:
    // Default: hud
    if (!activeTranscript) {
      console.error(noLogsMessage());
      process.exit(1);
    }
    const report = analyzeTranscript(activeTranscript, modelFlag);
    syncStatusFiles(report);
    printTerminalHUD(report);
    break;
}
}

// Run the CLI only when executed directly (also through the ~/.local/bin/sparelimit symlink), not when imported.
try {
  if (fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
    main().catch((err) => {
      console.error(err?.stack || err);
      process.exit(1);
    });
} catch {}
