import { buildHandoff } from "./handoff.mjs";
import { scrubSecrets } from "./secrets.mjs";
import path from "node:path";
import { loadPricing, resolveModel, ratesFor, costUSD } from "./pricing.mjs";
import { spendRate } from "./rates.mjs";
import { CONFIDENCE, minConfidence, emptyUsage, addUsage, totalTokens } from "./schema.mjs";

const FALLBACK_MODEL = "claude-sonnet-5-5";
const M = 1e6;

/** Price one event by its own model (or an override); unknown models fall back to a default rate and are flagged. */
/**
 * @param {any} ev
 * @param {any} pricing
 * @param {string | null} [modelOverride]
 */
export function priceEvent(ev, pricing, modelOverride = null) {
  const resolved = resolveModel(pricing, modelOverride || ev.model);
  let key = resolved?.key;
  let conf = modelOverride ? CONFIDENCE.ESTIMATED : ev.confidence;
  let unpriced = false;
  if (!key) {
    key = FALLBACK_MODEL;
    conf = CONFIDENCE.ESTIMATED;
    unpriced = true;
  }
  // the key is a model in the price list (resolved, or the fallback), so its rates exist
  const rates = /** @type {any} */ (ratesFor(pricing, key, { at: ev.ts || new Date(), promptTokens: ev.context }));
  return { key, rates, cost: costUSD(rates, ev.usage), conf, unpriced };
}

/**
 * Turn a normalized Session into the report used by the CLI, MCP server and dashboard.
 *  - every event is priced by its own model (or `modelOverride` for a what-if, which makes it "estimated")
 *  - unknown models fall back to a default rate and are flagged "estimated"
 */
/**
 * @param {any} session
 * @param {{ modelOverride?: string | null, pricing?: any }} [opts]
 */
export function buildReport(session, { modelOverride = null, pricing = loadPricing() } = {}) {
  const events = session.events;
  const mainThread = events.filter((/** @type {any} */ e) => !e.isSidechain);
  const unpriced = new Set();
  const perModel = new Map();
  const costParts = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  let usage = emptyUsage();
  let cost = 0;
  /** @type {string[]} */
  const confidences = [];
  let lastRates = null;
  let lastKey = null;

  const priced = events.map((/** @type {any} */ ev) => {
    const { key, rates, cost: c, conf, unpriced: wasUnpriced } = priceEvent(ev, pricing, modelOverride);
    if (wasUnpriced) unpriced.add(ev.model || "unknown");
    cost += c;
    usage = addUsage(usage, ev.usage);
    costParts.input += (ev.usage.input * rates.input) / M;
    costParts.cacheRead += (ev.usage.cacheRead * rates.cacheRead) / M;
    costParts.cacheWrite += (ev.usage.cacheWrite5m * rates.cacheWrite5m + ev.usage.cacheWrite1h * rates.cacheWrite1h) / M;
    costParts.output += (ev.usage.output * rates.output) / M;
    const pm = perModel.get(key) || { model: key, costUSD: 0, tokens: 0, responses: 0 };
    pm.costUSD += c;
    pm.tokens += totalTokens(ev.usage);
    pm.responses += 1;
    perModel.set(key, pm);
    confidences.push(conf);
    if (!ev.isSidechain) {
      lastRates = rates;
      lastKey = key;
    }
    return { ev, key, rates, cost: c, conf };
  });

  const grand = totalTokens(usage);
  const cacheWrite = usage.cacheWrite5m + usage.cacheWrite1h;
  const cacheReadRatio = grand > 0 ? Math.round((usage.cacheRead / grand) * 100) : 0;

  const latest = mainThread[mainThread.length - 1];
  const first = mainThread[0];
  const latestContext = latest?.context || 0;
  const growth = first?.context > 0 ? (latestContext / first.context).toFixed(1) : "1.0";

  const rate = spendRate(priced.map((/** @type {any} */ x) => ({ ts: x.ev.ts, cost: x.cost, tokens: totalTokens(x.ev.usage) })), session.userTurns.length);
  const sub = priced.filter((/** @type {any} */ x) => x.ev.isSidechain);
  const fanOut = { subagentResponses: sub.length, subagentCostUSD: Number(sub.reduce((/** @type {number} */ n, /** @type {any} */ x) => n + x.cost, 0).toFixed(4)), shareOfCost: cost > 0 ? Number((sub.reduce((/** @type {number} */ n, /** @type {any} */ x) => n + x.cost, 0) / cost).toFixed(3)) : 0, subagentFiles: session.raw?.subagentFiles || 0 };

  const rates = lastRates || { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 };
  /** @type {any} */
  const entry = (lastKey && pricing.models[lastKey]) || {};
  const nextTurnCostUSD = (latestContext / M) * rates.cacheRead + (1500 / M) * rates.output;
  const tenContinue = 10 * nextTurnCostUSD;
  const tenSurgical = 10 * ((3500 / M) * rates.cacheRead + (500 / M) * rates.output);
  const potentialSavingsUSD = Math.max(0, tenContinue - tenSurgical);

  // ---- file churn
  const touched = new Map();
  const seenTouch = new Set();
  for (const t of session.fileTouches) {
    if (t.id) {
      if (seenTouch.has(t.id)) continue;
      seenTouch.add(t.id);
    }
    const prev = touched.get(t.file) || { reads: 0, writes: 0 };
    if (t.kind === "read") prev.reads += 1;
    if (t.kind === "write") prev.writes += 1;
    touched.set(t.file, prev);
  }
  const reReadFiles = [];
  for (const [file, c] of touched) if (c.reads > 1 || c.writes >= 2) reReadFiles.push({ file, basename: path.basename(file), reads: c.reads, writes: c.writes });
  reReadFiles.sort((a, b) => b.reads + b.writes - (a.reads + a.writes));

  // ---- command failures
  let streak = 0;
  let maxStreak = 0;
  const failedCommands = [];
  for (const r of session.commandResults) {
    if (r.ok) streak = 0;
    else {
      streak += 1;
      maxStreak = Math.max(maxStreak, streak);
      failedCommands.push({ command: r.command, summary: r.summary });
    }
  }

  // ---- context thresholds relative to the model window (v0 heuristics, tunable later via config)
  const maxInput = entry.maxInput || 200000;
  const observedMax = Math.max(0, ...mainThread.map((/** @type {any} */ e) => e.context));
  const window = observedMax > 200000 ? maxInput : Math.min(maxInput, 200000);
  const ctxWarn = Math.max(35000, 0.25 * window);
  const ctxCritical = Math.max(75000, 0.5 * window);
  const turnCount = session.userTurns.length;

  const signals = [];
  if (reReadFiles.length > 0) signals.push(`File churn detected: ${reReadFiles.slice(0, 3).map((f) => `${f.basename} (${f.reads}r/${f.writes}w)`).join(", ")}`);
  if (failedCommands.length > 0) signals.push(`${failedCommands.length} command failure(s) injected error logs into context`);
  if (latestContext > ctxWarn) signals.push(`Active context window: ${(latestContext / 1000).toFixed(1)}k tokens/turn`);

  let flowStatus = "OPTIMAL FLOW";
  let statusLevel = "good";
  let shouldStop = false;
  let preActionAlert = "✓ Context is lean. Safe to continue.";
  let nextAction = "Stay in flow. Context is lean and turns are surgical.";
  const hasHighChurn = reReadFiles.some((f) => f.writes >= 3);
  const k = (/** @type {number} */ n) => `${(n / 1000).toFixed(1)}k`;

  if (latestContext > ctxCritical || maxStreak >= 3 || hasHighChurn) {
    flowStatus = "RESET RECOMMENDED";
    statusLevel = "critical";
    shouldStop = true;
    preActionAlert = `Start fresh before your next message: it will carry ${k(latestContext)} tokens of history (~$${nextTurnCostUSD.toFixed(3)}/turn, estimate). Starting fresh now saves ~$${potentialSavingsUSD.toFixed(2)} (estimate).`;
    nextAction = `Each new turn carries ${k(latestContext)} context tokens. Run 'sparelimit reset' or paste the handoff below into a fresh chat.`;
  } else if (latestContext > ctxWarn || reReadFiles.length > 0 || failedCommands.length > 0 || turnCount >= 14) {
    flowStatus = "WATCH CONTEXT DRIFT";
    statusLevel = "warn";
    preActionAlert = `The conversation has grown ${growth}x (${k(latestContext)} tokens). Your next message will cost ~$${nextTurnCostUSD.toFixed(3)} (estimate). Keep it to one file.`;
    nextAction = `Context grew ${growth}x since Turn 1. Finish your immediate task, then start fresh for the next feature.`;
  }

  if (events.length === 0 || grand === 0) {
    flowStatus = "NO DATA";
    statusLevel = "unknown";
    shouldStop = false;
    preActionAlert = "No token usage could be read from this transcript. Numbers below are not meaningful.";
    nextAction = "Pass a supported transcript path, or run with --global to pick another session.";
  }

  // ---- handoff
  const { prompt: handoffPrompt, hidden: handoffPromptHidden } = buildHandoff(session);

  return {
    sessionId: session.sessionId,
    agent: session.agent,
    transcriptPath: session.transcriptPath,
    updatedAt: new Date().toISOString(),
    selectedModelKey: modelOverride,
    modelName: modelOverride || lastKey || "unknown",
    turnCount,
    modelStepsCount: mainThread.length,
    confidence: events.length ? minConfidence(confidences) : CONFIDENCE.ESTIMATED,
    unpricedModels: [...unpriced],
    pricesAsOf: pricing.generatedAt,
    dedup: session.raw,
    fanOut,
    spendRate: rate,
    tokens: { input: usage.input, cacheRead: usage.cacheRead, cacheWrite, output: usage.output, total: grand, cacheReadRatio, latestTurnContext: latestContext, contextGrowthMultiplier: growth, contextWindow: window },
    pricing: { name: lastKey || "unknown", provider: entry.provider, input: rates.input, cacheRead: rates.cacheRead, cacheWrite: rates.cacheWrite5m, output: rates.output },
    realCostUSD: Number(cost.toFixed(4)),
    costBreakdownUSD: Object.fromEntries(Object.entries(costParts).map(([k2, v]) => [k2, Number(v.toFixed(4))])),
    byModel: [...perModel.values()].map((m) => ({ ...m, costUSD: Number(m.costUSD.toFixed(4)) })).sort((a, b) => b.costUSD - a.costUSD),
    nextTurnCostUSD: Number(nextTurnCostUSD.toFixed(4)),
    potentialSavingsUSD: Number(potentialSavingsUSD.toFixed(2)),
    savingsConfidence: CONFIDENCE.ESTIMATED,
    flowStatus,
    statusLevel,
    shouldStop,
    preActionAlert,
    nextAction,
    signals,
    touchedFiles: [...touched.entries()].map(([file, c]) => ({ file, basename: path.basename(file), reads: c.reads, writes: c.writes })),
    reReadFiles,
    failedCommands: failedCommands.map((f) => ({ command: scrubSecrets(f.command), summary: scrubSecrets(f.summary) })),
    userTurns: session.userTurns.map((/** @type {any} */ t, /** @type {any} */ i) => ({ stepIndex: i, text: scrubSecrets(t.text), createdAt: t.createdAt })),
    plannerSteps: mainThread.map((/** @type {any} */ e, /** @type {any} */ i) => ({ stepIndex: e.stepIndex ?? i, inputTokens: e.usage.input, cacheReadTokens: e.usage.cacheRead, outputTokens: e.usage.output, contextSize: e.context, tools: e.tools })),
    handoffPrompt,
    handoffPromptHidden
  };
}
