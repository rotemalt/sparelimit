import { findRework } from "./rework.mjs";
import { evaluate } from "./policy.mjs";
import { priceEvent } from "./analyze.mjs";
import { loadPricing } from "./pricing.mjs";
import { fanOutReport, isVerbose, verboseSavings, median } from "./delegation.mjs";
import { modelReport, summarizeModels, taskType } from "./models.mjs";

const WINDOW_CALLS = 20;
const M = 1e6;
/** Assumptions behind the replay's estimates (quoted by the methodology page, so they cannot drift from the code). */
export const REPLAY = { charsPerToken: 3.7, summaryOutTokens: 3000, resetThreshold: 0.6, rebuildTokens: 25_000, rebuildLowSaving: 60_000, rebuildHighSaving: 0, minMessagesToModel: 30, compactionDrop: 0.65, defaultPostCompactionFraction: 0.2, coldMinContext: 50_000, coldMinExtraUSD: 0.5, coldMissedShare: 0.2, handoffTokens: 4_000, startContextCap: 100_000 };
const CHARS_PER_TOKEN = REPLAY.charsPerToken; // rough; tool-result sizes are measured in characters
const SUMMARY_OUT_TOKENS = REPLAY.summaryOutTokens;

const toolKind = (name = "") => (name === "Read" ? "Read" : name === "Bash" ? "Command output" : /^(Grep|Glob|LS)$/.test(name) ? "Search" : /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(name) ? "Edit/Write" : /^(WebFetch|WebSearch)$/.test(name) ? "Web" : /^(Task|Agent)$/.test(name) ? "Subagent" : name.startsWith("mcp__") ? "Browser and MCP tools" : "Other tools");

/**
 * Model what the cache-read bill would have been if the conversation had been reset (a clean handoff) as soon as the
 * context reached `threshold` of the window, instead of growing until the agent auto-compacted. Both sides use the same
 * simplified model, driven by the real per-response growth in the log:
 *   cost = sum(context x cache-read rate) + per reset (rebuilt context written once + a short summary written)
 * `rebuildTokens` is the extra context re-read after each reset (the "files read again" effect); it is an assumption.
 * Result is an ESTIMATE of a different behaviour, not something that was measured.
 */
/**
 * @param {any[]} main the main-thread responses, priced
 * @param {number} windowTok
 * @param {{ threshold?: number, rebuildTokens?: number }} [opts]
 */
export function modelEarlierReset(main, windowTok, { threshold = REPLAY.resetThreshold, rebuildTokens = REPLAY.rebuildTokens } = {}) {
  if (main.length < REPLAY.minMessagesToModel) return null;
  const steps = main.map((m, i) => {
    const prev = i ? main[i - 1].ev.context : m.ev.context;
    const comp = i > 0 && m.ev.context < prev * REPLAY.compactionDrop; // real auto-compaction: context fell sharply
    return { c: m.ev.context, comp, n: comp ? 0 : Math.max(0, m.ev.context - prev), rr: m.rates.cacheRead, cw: m.rates.cacheWrite5m, out: m.rates.output };
  });
  const post = steps.filter((x) => x.comp).map((x) => x.c / windowTok).sort((a, b) => a - b);
  const baseFrac = post.length ? post[Math.floor(post.length / 2)] : REPLAY.defaultPostCompactionFraction;
  let actual = 0;
  for (const x of steps) {
    actual += (x.c * x.rr) / M;
    if (x.comp) actual += (x.c * x.cw) / M + (SUMMARY_OUT_TOKENS * x.out) / M;
  }
  const base = baseFrac * windowTok;
  let s = steps[0].c;
  let sim = 0;
  let resets = 0;
  steps.forEach((x, i) => {
    if (i > 0) s += x.n;
    if (s >= threshold * windowTok) {
      resets += 1;
      s = base + rebuildTokens;
      sim += ((base + rebuildTokens) * x.cw) / M + (SUMMARY_OUT_TOKENS * x.out) / M;
    }
    sim += (s * x.rr) / M;
  });
  return { actualModelUSD: actual, earlierResetModelUSD: sim, savingUSD: actual - sim, resets, realCompactions: post.length, baseFraction: baseFrac };
}

/**
 * Replay the hard-stop policy over a finished session: what would Sparelimit have said, and when?
 * Uses only data a transcript has (context size, cumulative cost, repeated tool calls). Quota rules need the live
 * status line, so they are not replayed.
 *
 * Numbers are labelled:
 *   - "derived": summed from the log (e.g. spend that happened after the first stop)
 *   - "estimated": needs an assumption (what the same turns would have cost in a fresh session)
 */
/**
 * @param {import('./schema.mjs').Session} session
 * @param {{ policy?: any, pricing?: any, withEvents?: boolean }} [opts]
 */
export function replaySession(session, { policy = { budget: { sessionWarnUSD: null, sessionBlockUSD: null } }, pricing = loadPricing(), withEvents = false } = {}) {
  /** @type {(import('./schema.mjs').PricedEvent & { coldUSD?: number })[]} */
  const priced = session.events
    .map((ev, i) => ({ ev, i, ...priceEvent(ev, pricing) }))
    .filter((x) => x.ev.ts)
    .sort((a, b) => new Date(a.ev.ts).getTime() - new Date(b.ev.ts).getTime() || a.i - b.i);
  if (!priced.length) return null;

  const total = priced.reduce((n, x) => n + x.cost, 0);
  const main = priced.filter((x) => !x.ev.isSidechain);
  const observedMax = Math.max(0, ...main.map((x) => x.ev.context));
  const maxInput = pricing.models[main[0]?.key]?.maxInput || 200000;
  const windowTokens = observedMax > 200000 ? maxInput : Math.min(maxInput, 200000);

  const t0 = new Date(priced[0].ev.ts).getTime();
  const tEnd = new Date(priced[priced.length - 1].ev.ts).getTime();
  // Active time: gaps over 10 minutes (away, overnight, resumed days later) do not count.
  const activeAt = new Map();
  let active = 0;
  priced.forEach((x, pos) => {
    if (pos > 0) {
      const gap = new Date(x.ev.ts).getTime() - new Date(priced[pos - 1].ev.ts).getTime();
      if (gap <= 10 * 60e3) active += gap;
    }
    activeAt.set(pos, active);
  });
  const totalActive = active;
  const minutesIn = (/** @type {number} */ pos) => Math.round(activeAt.get(pos) / 60e3);

  /** @type {{ lastSig: string | null, count: number, recent: string[], recentRes: string[] }} */
  const state = { lastSig: null, count: 0, recent: [], recentRes: [] };
  const seen = new Map(); // rule -> last level, to log only first appearances and escalations
  /** @type {any[]} */
  const findings = [];
  /** @type {number[]} */
  const cumAfter = []; // cumulative cost after each priced event (by position)
  let cum = 0;
  /** @type {{ eventPos: number | null, avoidPositions: Set<number> }} */
  const loopBlock = { eventPos: null, avoidPositions: new Set() };
  /** @type {{ sig: string | null, count: number }} */
  let streak = { sig: null, count: 0 };

  priced.forEach((x, pos) => {
    cum += x.cost;
    cumAfter[pos] = cum;
    if (x.ev.isSidechain) return;
    const snapshot = { costUsd: cum, contextTokens: x.ev.context, contextPct: (x.ev.context / windowTokens) * 100 };
    const calls = x.ev.calls?.length ? x.ev.calls : [null];
    for (const call of calls) {
      let loop;
      if (call) {
        state.count = call.sig === state.lastSig ? state.count + 1 : 1;
        state.lastSig = call.sig;
        state.recent = [...state.recent, call.sig].slice(-WINDOW_CALLS);
        const key = call.res ? `${call.sig}|${call.res}` : null;
        if (key) state.recentRes = [...state.recentRes, key].slice(-WINDOW_CALLS);
        loop = { count: state.count, tool: call.name, windowCount: state.recent.filter((s) => s === call.sig).length, noProgress: key ? state.recentRes.filter((s) => s === key).length : 0 };
        streak = call.sig === streak.sig ? { sig: streak.sig, count: streak.count + 1 } : { sig: call.sig, count: 1 };
      }
      const r = evaluate({ snapshot, loop, policy, now: new Date(x.ev.ts).getTime() });
      for (const f of r.findings) {
        if (seen.get(f.rule) === f.level) continue;
        if (seen.get(f.rule) === "block" && f.level === "warn") continue;
        seen.set(f.rule, f.level);
        findings.push({ t: x.ev.ts, minute: minutesIn(pos), pos, rule: f.rule, level: f.level, message: f.message, costSoFarUSD: round(cum) });
        if (f.level === "block" && f.rule.startsWith("loop.") && loopBlock.eventPos == null) loopBlock.eventPos = pos;
      }
      // events that keep repeating after the loop block point are the avoidable part
      if (loopBlock.eventPos != null && pos > loopBlock.eventPos && call && (streak.count >= 8 || (loop?.noProgress ?? 0) >= 8)) loopBlock.avoidPositions.add(pos);
    }
  });

  const firstWarn = findings.find((f) => f.level === "warn" || f.level === "block");
  const firstBlock = findings.find((f) => f.level === "block");
  const after = (/** @type {{ pos: number } | null | undefined} */ f) => (f ? round(total - cumAfter[f.pos]) : 0);
  const minutesAfter = (/** @type {{ pos: number } | null | undefined} */ f) => (f ? Math.max(0, Math.round((totalActive - activeAt.get(f.pos)) / 60e3)) : 0);

  // derived: cost of the events that kept repeating after the loop stop point
  const loopAvoidable = round([...loopBlock.avoidPositions].reduce((n, pos) => n + priced[pos].cost, 0));

  // estimated: after a context stop, what the same turns would cost starting fresh (3.5k tokens of handoff, same outputs)
  let contextAvoidable = 0;
  let stretchCount = 0;
  const ctxBlock = findings.find((f) => f.level === "block" && f.rule === "context.window");
  if (ctxBlock) {
    // only the stretch where the context stayed large (until it dropped below the warning level, e.g. after auto-compaction)
    const stretch = [];
    for (const x of priced.slice(ctxBlock.pos + 1)) {
      if (x.ev.isSidechain) continue;
      if ((x.ev.context / windowTokens) * 100 < 60) break;
      stretch.push(x);
    }
    const rest = stretch;
    stretchCount = stretch.length;
    const actual = rest.reduce((n, x) => n + x.cost, 0);
    const fresh = rest.reduce((n, x) => n + (3500 * x.rates.cacheRead + x.ev.usage.output * x.rates.output + x.ev.usage.input * x.rates.input) / M, 0);
    contextAvoidable = round(Math.max(0, actual - fresh));
  }

  // ---- where the money goes (derived from the log)
  const parts = { cacheRead: 0, cacheWrite: 0, output: 0, input: 0 };
  for (const x of priced) {
    parts.cacheRead += (x.ev.usage.cacheRead * x.rates.cacheRead) / M;
    parts.cacheWrite += (x.ev.usage.cacheWrite5m * x.rates.cacheWrite5m + x.ev.usage.cacheWrite1h * x.rates.cacheWrite1h) / M;
    parts.output += (x.ev.usage.output * x.rates.output) / M;
    parts.input += (x.ev.usage.input * x.rates.input) / M;
  }
  // the fixed starting context (system prompt, tools, memory) is re-sent on every message: use the smallest context seen
  const startTokens = main.length >= 5 ? Math.min(...main.map((x) => x.ev.context)) : 0;
  const startCost = main.reduce((n, x) => n + (startTokens * x.rates.cacheRead) / M, 0);

  // cost of carrying each kind of tool output in context until the next auto-compaction
  /** @type {Record<string, number>} */
  const carry = {};
  /** @type {{ tool: string, kind: string, tokens: number, carryUSD: number }[]} */
  const verbose = [];
  const compAt = main.map((x, i) => i > 0 && x.ev.context < main[i - 1].ev.context * 0.65);
  let reads = 0;
  let identicalReads = 0;
  let identicalReadsUSD = 0;
  const seenReads = new Set();
  /** @type {Map<string, { reads: number, wholeReads: number, tokens: number, largest: number, carryUSD: number }>} */
  const fileReads = new Map();
  main.forEach((x, i) => {
    for (const call of x.ev.calls || []) {
      if (!call.resChars) continue;
      const kind = toolKind(call.name);
      const tokens = call.resChars / CHARS_PER_TOKEN;
      const j = i + 1;
      if (j >= main.length) continue;
      let cost = (tokens * main[j].rates.cacheWrite5m) / M;
      for (let k = j; k < main.length; k++) {
        if (k > j && compAt[k]) break;
        cost += (tokens * main[k].rates.cacheRead) / M;
      }
      carry[kind] = (carry[kind] || 0) + cost;
      if (kind !== "Subagent" && isVerbose(tokens)) verbose.push({ tool: call.name, kind, tokens: Math.round(tokens), carryUSD: cost });
      if (call.name === "Read" && call.res && !call.res.startsWith("!")) {
        reads += 1;
        const key = `${call.sig}|${call.res}`;
        if (seenReads.has(key)) {
          identicalReads += 1;
          identicalReadsUSD += cost;
        }
        seenReads.add(key);
        if (call.file) {
          const f = fileReads.get(call.file) || { reads: 0, wholeReads: 0, tokens: 0, largest: 0, carryUSD: 0 };
          f.reads += 1;
          if (call.partial === false) f.wholeReads += 1;
          f.tokens += tokens;
          f.largest = Math.max(f.largest, tokens);
          f.carryUSD += cost;
          fileReads.set(call.file, f);
        }
      }
    }
  });
  // ---- cold-cache messages: the first message after a break longer than the cache lifetime re-processed the whole conversation
  const uses1h = main.some((x) => x.ev.usage.cacheWrite1h > 0);
  const breaks = { messages: 0, resumeUSD: 0, freshUSD: 0, extraUSD: 0, over60min: 0 };
  main.forEach((x, i) => {
    if (i === 0) return;
    const ctx = x.ev.context;
    const gap = new Date(x.ev.ts).getTime() - new Date(main[i - 1].ev.ts).getTime();
    const ttl = uses1h ? 3600e3 : 300e3;
    const missed = x.ev.usage.cacheRead < REPLAY.coldMissedShare * ctx && !compAt[i];
    if (ctx < REPLAY.coldMinContext || gap <= ttl + 10e3 || !missed) return;
    const w = uses1h ? x.rates.cacheWrite1h : x.rates.cacheWrite5m;
    const extra = (ctx * (w - x.rates.cacheRead)) / M;
    if (extra < REPLAY.coldMinExtraUSD) return;
    breaks.messages += 1;
    breaks.resumeUSD += (ctx * w) / M;
    breaks.freshUSD += ((startTokens + REPLAY.handoffTokens + REPLAY.rebuildTokens) * w) / M;
    breaks.extraUSD += extra;
    x.coldUSD = extra; // marks this response as a cold return, for the adoption timeline
    if (gap > 3600e3) breaks.over60min += 1;
  });
  // ---- who did the work: side threads (subagents) and which model family (derived); half the Opus work on Sonnet is a what-if (estimated)
  const family = (key = "") => (/opus/.test(key) ? "opus" : /sonnet/.test(key) ? "sonnet" : /haiku/.test(key) ? "haiku" : "other");
  const byModel = { opus: 0, sonnet: 0, haiku: 0, other: 0 };
  /** @type {Record<string, { responses: number, usd: number }>} */
  const byTrigger = {};
  let sidechainUSD = 0;
  let opusToSonnetDelta = 0;
  for (const x of priced) {
    byModel[family(x.key)] += x.cost;
    if (x.ev.isSidechain) sidechainUSD += x.cost;
    else {
      const t = byTrigger[x.ev.trigger || "typed"] ||= { responses: 0, usd: 0 };
      t.responses += 1;
      t.usd += x.cost;
    }
    if (family(x.key) === "opus") opusToSonnetDelta += Math.max(0, x.cost - priceEvent(x.ev, pricing, "claude-sonnet-5-5").cost);
  }
  const earlier = modelEarlierReset(main, windowTokens);
  const earlierLow = modelEarlierReset(main, windowTokens, { rebuildTokens: REPLAY.rebuildLowSaving });
  const earlierHigh = modelEarlierReset(main, windowTokens, { rebuildTokens: REPLAY.rebuildHighSaving });

  return {
    sessionId: session.sessionId,
    agent: session.agent,
    project: session.projectDir || (session.transcriptPath ? String(session.transcriptPath).replace(/[\\/][^\\/]*$/, "") : null),
    // per-response facts for period reports and adoption tracking (large: opt-in): when, cost, side thread, context % of the window (main thread only),
    // expensive model, task type, the extra cost of a cold-cache return, context tokens, tool calls that came back as errors, and which subagent
    ...(withEvents ? { timeline: priced.map((x) => ({ t: new Date(x.ev.ts).getTime(), cost: x.cost, side: !!x.ev.isSidechain, pct: x.ev.isSidechain ? null : Math.round((x.ev.context / windowTokens) * 1000) / 10, exp: /opus|fable/.test(x.key), type: taskType(x.ev), coldUSD: x.coldUSD || 0, ctx: x.ev.context, errs: (x.ev.calls || []).filter((c) => c.res && c.res.startsWith("!")).length, agent: x.ev.agentId || null })) } : {}),
    start: priced[0].ev.ts,
    end: priced[priced.length - 1].ev.ts,
    durationMin: Math.round(totalActive / 60e3),
    spanDays: Number(((tEnd - t0) / 86400e3).toFixed(1)),
    responses: priced.length,
    totalCostUSD: round(total),
    contextWindowTokens: windowTokens,
    findings,
    firstWarn: firstWarn ? slim(firstWarn) : null,
    firstBlock: firstBlock ? slim(firstBlock) : null,
    exposure: {
      afterFirstWarnUSD: after(firstWarn),
      afterFirstWarnMinutes: minutesAfter(firstWarn),
      afterFirstStopUSD: after(firstBlock),
      afterFirstStopMinutes: minutesAfter(firstBlock),
      confidence: "derived"
    },
    avoidable: {
      repeatedCallsUSD: loopAvoidable,
      repeatedCallsConfidence: "derived",
      oversizedContextUSD: earlier ? round(Math.max(0, earlier.savingUSD)) : 0,
      oversizedContextConfidence: "estimated: modelled earlier reset, see earlierReset",
      contextStretchResponses: ctxBlock ? stretchCount : 0
    },
    spendBreakdown: { cacheReadUSD: round(parts.cacheRead), cacheWriteUSD: round(parts.cacheWrite), outputUSD: round(parts.output), inputUSD: round(parts.input), startContextTokens: startTokens, startContextUSD: round(startCost), confidence: "derived" },
    toolOutputCarryUSD: Object.fromEntries(Object.entries(carry).map(([k, v]) => [k, round(v)])),
    toolOutputConfidence: "estimated (sizes measured in characters, about 3.7 per token)",
    breaks: { messages: breaks.messages, over60min: breaks.over60min, resumeUSD: round(breaks.resumeUSD), freshUSD: round(breaks.freshUSD), savingUSD: round(Math.max(0, breaks.resumeUSD - breaks.freshUSD)), extraVsWarmUSD: round(breaks.extraUSD), confidence: "estimated: the fresh-start cost assumes a short handoff and about 25k tokens re-read" },
    models: modelReport(priced, pricing),
    delegation: { ...fanOutReport(priced, total), verbose: verbose.map((v) => ({ ...v, carryUSD: round(v.carryUSD) })) },
    rework: findRework(priced),
    files: [...fileReads.entries()].sort((a, b) => b[1].carryUSD - a[1].carryUSD).slice(0, 15).map(([file, f]) => ({ file, reads: f.reads, wholeReads: f.wholeReads, tokens: Math.round(f.tokens), largestReadTokens: Math.round(f.largest), carryUSD: round(f.carryUSD) })),
    sidechainUSD: round(sidechainUSD),
    byTrigger: Object.fromEntries(Object.entries(byTrigger).map(([k, v]) => [k, { responses: v.responses, usd: round(v.usd) }])),
    byModelUSD: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, round(v)])),
    opusHalfToSonnetUSD: round(opusToSonnetDelta / 2),
    reads: { total: reads, identicalRepeats: identicalReads, identicalRepeatsCarryUSD: round(identicalReadsUSD) },
    earlierReset: earlier && {
      threshold: 0.6,
      realCompactions: earlier.realCompactions,
      actualModelUSD: round(earlier.actualModelUSD),
      savingUSD: round(earlier.savingUSD),
      savingLowUSD: round(earlierLow?.savingUSD ?? 0), // earlierLow and earlierHigh are null exactly when earlier is (too few messages), and earlier is set here
      savingHighUSD: round(earlierHigh?.savingUSD ?? 0),
      resets: earlier.resets,
      confidence: "estimated"
    },
    note: "Quota rules need live status-line data and are not replayed."
  };
}

/** @typedef {NonNullable<ReturnType<typeof replaySession>>} ReplayResult one replayed session, as `replaySession` returns it */

const slim = (/** @type {any} */ f) => ({ minute: f.minute, rule: f.rule, level: f.level, costSoFarUSD: f.costSoFarUSD, message: f.message });
const round = (/** @type {number} */ x) => Number(x.toFixed(2));
const sum2 = (/** @type {any[]} */ list, /** @type {(r: any) => number} */ fn) => round(list.reduce((n, r) => n + fn(r), 0));

/** @param {(ReplayResult | null | undefined)[]} results */
export function summarize(results) {
  /** @type {ReplayResult[]} */
  const ok = /** @type {any} */ (results.filter(Boolean));
  const sum = (/** @type {(r: ReplayResult) => number} */ fn) => round(ok.reduce((n, r) => n + fn(r), 0));
  const warned = ok.filter((r) => r.firstWarn);
  const stopped = ok.filter((r) => r.firstBlock);
  return {
    sessions: ok.length,
    totalCostUSD: sum((r) => r.totalCostUSD),
    sessionsWithWarning: warned.length,
    sessionsWithStop: stopped.length,
    spendAfterFirstWarningUSD: sum((r) => r.exposure.afterFirstWarnUSD),
    spendAfterFirstStopUSD: sum((r) => r.exposure.afterFirstStopUSD),
    avoidableRepeatedCallsUSD: sum((r) => r.avoidable.repeatedCallsUSD),
    avoidableOversizedContextUSD: sum((r) => r.avoidable.oversizedContextUSD),
    spendBreakdownUSD: ["cacheReadUSD", "cacheWriteUSD", "outputUSD", "inputUSD", "startContextUSD"].reduce((m, k) => ((m[k] = sum((r) => /** @type {Record<string, any>} */ (r.spendBreakdown)[k])), m), /** @type {Record<string, number>} */ ({})),
    toolOutputCarryUSD: ok.reduce((m, r) => { for (const [k, v] of Object.entries(r.toolOutputCarryUSD)) m[k] = round((m[k] || 0) + v); return m; }, /** @type {Record<string, number>} */ ({})),
    reads: { total: ok.reduce((n, r) => n + r.reads.total, 0), identicalRepeats: ok.reduce((n, r) => n + r.reads.identicalRepeats, 0), identicalRepeatsCarryUSD: sum((r) => r.reads.identicalRepeatsCarryUSD) },
    earlierReset: (() => {
      const e = ok.filter((r) => r.earlierReset);
      return { sessionsModelled: e.length, actualModelUSD: sum2(e, (r) => r.earlierReset.actualModelUSD), netSavingUSD: sum2(e, (r) => r.earlierReset.savingUSD), netSavingLowUSD: sum2(e, (r) => r.earlierReset.savingLowUSD), netSavingHighUSD: sum2(e, (r) => r.earlierReset.savingHighUSD), confidence: "estimated" };
    })(),
    breaks: { messages: ok.reduce((n, r) => n + r.breaks.messages, 0), over60min: ok.reduce((n, r) => n + r.breaks.over60min, 0), resumeUSD: sum((r) => r.breaks.resumeUSD), savingUSD: sum((r) => r.breaks.savingUSD), extraVsWarmUSD: sum((r) => r.breaks.extraVsWarmUSD) },
    delegation: (() => {
      const agents = ok.flatMap((r) => r.delegation.details);
      const medianAgentCostUSD = median(agents.map((a) => a.costUSD));
      const per = ok.map((r) => verboseSavings(r.delegation.verbose, medianAgentCostUSD));
      const verdicts = ok.reduce((m, r) => ((m[r.delegation.verdict] = (m[r.delegation.verdict] || 0) + 1), m), /** @type {Record<string, number>} */ ({}));
      const swarmSessions = ok.filter((r) => r.delegation.verdict === "swarm");
      return {
        agents: agents.length,
        sessionsWithAgents: ok.filter((r) => r.delegation.agents).length,
        verdicts,
        medianAgentCostUSD: round(medianAgentCostUSD),
        medianAgentStartTokens: median(agents.map((a) => a.startContextTokens)),
        medianAnswerTokens: median(agents.map((a) => a.answerTokens).filter((n) => n != null)),
        swarmSpendUSD: sum2(swarmSessions, (r) => r.delegation.sideUSD),
        lightAgents: ok.reduce((n, r) => n + r.delegation.lightAgents, 0),
        lightAgentsUSD: sum2(ok, (r) => r.delegation.lightUSD),
        verboseOutputs: per.reduce((n, p) => n + p.outputs, 0),
        verboseCarryUSD: round(per.reduce((n, p) => n + p.carryUSD, 0)),
        verboseNetSavingUSD: round(per.reduce((n, p) => n + p.netSavingUSD, 0)),
        sessionsWhereDelegatingPays: per.filter((p) => p.netSavingUSD > 0).length,
        confidence: "derived for the agent figures; estimated for the saving"
      };
    })(),
    models: summarizeModels(ok.map((r) => r.models), ok.map((r) => r.delegation.details)),
    sidechainUSD: sum((r) => r.sidechainUSD),
    byTriggerUSD: ok.reduce((m, r) => { for (const [k, v] of Object.entries(r.byTrigger || {})) { const c = (m[k] ||= { responses: 0, usd: 0, sessions: 0 }); c.responses += v.responses; c.usd = round(c.usd + v.usd); c.sessions += 1; } return m; }, /** @type {Record<string, { responses: number, usd: number, sessions: number }>} */ ({})),
    reworkUSD: { rewriteLoopUSD: sum((r) => r.rework?.rewriteLoopUSD ?? 0), failingRepeatUSD: sum((r) => r.rework?.failingRepeatUSD ?? 0) },
    byModelUSD: ["opus", "sonnet", "haiku", "other"].reduce((m, k) => ((m[k] = sum((r) => /** @type {Record<string, number>} */ (r.byModelUSD)[k])), m), /** @type {Record<string, number>} */ ({})),
    opusHalfToSonnetUSD: sum((r) => r.opusHalfToSonnetUSD),
    firstStart: ok.map((r) => r.start).sort()[0] || null,
    lastEnd: ok.map((r) => r.end).sort().slice(-1)[0] || null,
    byRule: ok.flatMap((r) => r.findings).reduce((m, f) => ((m[`${f.rule}:${f.level}`] = (m[`${f.rule}:${f.level}`] || 0) + 1), m), {})
  };
}
