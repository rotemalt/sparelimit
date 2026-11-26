import fs from "node:fs";
import { loadPricing, resolveModel, ratesFor } from "./pricing.mjs";
import { loadCalibration, fitLimits } from "./planestimate.mjs";

/**
 * Break advisor (coach lever K2). The prompt cache expires after 5 minutes or 1 hour of silence. The first message after that
 * re-processes the WHOLE conversation at the cache-write price (about 25x the cache-read price). If the conversation is big, it can
 * be cheaper to start fresh with a short handoff than to resume. Measured on 93 real sessions: 192 such cold-cache messages cost
 * $489 = 10.6% of spend, 8.7% of it after breaks over an hour.
 */
export const COACH_DEFAULTS = { enabled: true, breakMinUSD: 0.5, minContextTokens: 50_000, deliver: "both", handoffTokens: 4_000, rebuildTokens: 25_000, resetAtPct: 60, resetMinSavingUSD: 0.25, resetHorizonMessages: 100 };

/** Read the last `bytes` of a (possibly large) transcript without loading all of it. */
export function readTail(/** @type {string} */ file, bytes = 400_000) {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString("utf8");
    return size > len ? text.slice(text.indexOf("\n") + 1) : text; // drop the partial first line
  } finally {
    fs.closeSync(fd);
  }
}

/** Facts about the last main-thread response in the tail: when, how big the conversation was, which model, which cache lifetime. */
export function lastTurn(/** @type {any} */ tail) {
  /** @type {any} */
  let last = null;
  const sizes = [];
  let maxCtx = 0;
  const growth = [];
  let prevCtx = null;
  for (const line of tail.split("\n")) {
    if (!line.includes('"type":"assistant"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o.message;
    if (o.type !== "assistant" || o.isSidechain || !m?.usage || m.model === "<synthetic>") continue;
    const u = m.usage;
    const ctx = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (ctx > 10_000) sizes.push(ctx);
    maxCtx = Math.max(maxCtx, ctx);
    if (prevCtx != null && ctx > prevCtx) growth.push(ctx - prevCtx); // drops (compaction, /clear) are not growth
    prevCtx = ctx;
    last = { t: Date.parse(o.timestamp), model: m.model, ctx, wrote1h: u.cache_creation?.ephemeral_1h_input_tokens || 0, wrote5m: u.cache_creation?.ephemeral_5m_input_tokens || 0 };
  }
  if (!last) return null;
  const ttls = [...tail.matchAll(/"ttl":"(1h|5m)"/g)];
  last.ttl = ttls.length ? ttls[ttls.length - 1][1] : last.wrote5m > 0 && last.wrote1h === 0 ? "5m" : "1h"; // unknown: assume 1h (fewer false alarms)
  last.baseTokens = sizes.length ? Math.min(...sizes) : 0;
  last.maxCtx = maxCtx;
  const g = growth.sort((a, b) => a - b);
  last.growthPerMessage = g.length ? g[Math.floor(g.length / 2)] : 0; // median
  return last;
}

const fmtK = (/** @type {number} */ n) => `${Math.round(n / 1000)}k`;
const usd = (/** @type {number} */ n) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;

/** The advice for the next message, or null when the cache is warm, the conversation is small, or the extra cost is not worth a nudge. */
/** @param {{ now?: number, tail: any, pricing?: any, calibration?: any, config?: any }} p */
export function coldCacheAdvice({ now = Date.now(), tail, pricing = loadPricing(), calibration = loadCalibration(), config = {} }) {
  const cfg = { ...COACH_DEFAULTS, ...config };
  if (!cfg.enabled || !tail) return null;
  const turn = lastTurn(tail);
  if (!turn || !Number.isFinite(turn.t) || turn.ctx < cfg.minContextTokens) return null;
  const ttlMs = turn.ttl === "5m" ? 5 * 60e3 : 3600e3;
  const gapMs = now - turn.t;
  if (gapMs <= ttlMs + 10_000) return null; // still warm
  const model = resolveModel(pricing, turn.model);
  if (!model) return null;
  // the model was resolved from the price list, so its rates exist
  const rates = /** @type {any} */ (ratesFor(pricing, model.key, { at: now, promptTokens: turn.ctx }));
  const writeRate = turn.ttl === "5m" ? rates.cacheWrite5m : rates.cacheWrite1h;
  const resumeUSD = (turn.ctx * writeRate) / 1e6;
  const extraUSD = (turn.ctx * (writeRate - rates.cacheRead)) / 1e6; // what a warm cache would have saved
  if (extraUSD < cfg.breakMinUSD) return null;
  const start = Math.min(turn.baseTokens || 88_000, 100_000); // a long session may never have been small in this tail; a new one starts near 70-100k (median 88k measured)
  const freshTokens = start + cfg.handoffTokens + cfg.rebuildTokens; // start-up context + the handoff + files re-read afterwards (an assumption)
  const freshUSD = (freshTokens * writeRate) / 1e6;
  const limit = fitLimits(calibration.points).fiveHourUSD;
  const pctOfLimit = limit ? (resumeUSD / limit) * 100 : null;
  const gapMin = Math.round(gapMs / 60e3);
  const away = gapMin >= 120 ? `${(gapMin / 60).toFixed(1)} h` : `${gapMin} min`;
  const message =
    `Your conversation (~${fmtK(turn.ctx)} tokens) went cold after ${away} away (the cache lasts ${turn.ttl === "5m" ? "5 minutes" : "1 hour"}). ` +
    `Sending this message re-processes all of it: about ${usd(resumeUSD)}${pctOfLimit != null ? ` (about ${pctOfLimit < 1 ? "<1" : Math.round(pctOfLimit)}% of your 5-hour limit)` : ""}. ` +
    `Starting fresh with a short handoff (and re-reading a few files) would cost about ${usd(freshUSD)}: run \`sparelimit reset\`, then /clear and paste it.`;
  return { rule: "cache.cold", message, evidence: { gapMin, contextTokens: turn.ctx, ttl: turn.ttl, resumeUSD: Number(resumeUSD.toFixed(2)), extraUSD: Number(extraUSD.toFixed(2)), freshUSD: Number(freshUSD.toFixed(2)), pctOfFiveHourLimit: pctOfLimit != null ? Number(pctOfLimit.toFixed(1)) : null } };
}

/**
 * Reset coach (coach lever K1). Reads the context size from the transcript (the status line does not run in the Desktop app), so it
 * works wherever the hooks run. Claude Code compacts on its own near 95% of the window, so the question is not "reset or never" but
 * "reset now or at 95%". Until then every message re-reads the whole conversation at the cache-read price; resetting now keeps the
 * conversation smaller for that whole stretch. Saving = messages until ~95% x (current context - fresh start) x cache-read price
 * (both paths pay one rebuild, now or later, so it cancels). Same model as the replay's "reset at 60%", for one conversation.
 * Returns null when the context is small, the cache is cold (the break advisor covers that) or the saving is trivial.
 * All figures are ESTIMATES: the handoff size, the files re-read afterwards, and the pace of growth are assumptions (config `coach`).
 */
/** @param {{ now?: number, tail: any, pricing?: any, calibration?: any, config?: any }} p */
export function resetAdvice({ now = Date.now(), tail, pricing = loadPricing(), calibration = loadCalibration(), config = {} }) {
  const cfg = { ...COACH_DEFAULTS, ...config };
  if (!cfg.enabled || !tail) return null;
  const turn = lastTurn(tail);
  if (!turn || !Number.isFinite(turn.t) || turn.ctx < cfg.minContextTokens) return null;
  const model = resolveModel(pricing, turn.model);
  if (!model) return null;
  const maxInput = pricing.models[model.key]?.maxInput || 200_000;
  const windowTokens = turn.maxCtx > 200_000 ? maxInput : Math.min(maxInput, 200_000); // same rule as replay: a 1M window is assumed only once a conversation has passed 200k
  const pct = (turn.ctx / windowTokens) * 100;
  if (pct < cfg.resetAtPct) return null;
  const ttlMs = turn.ttl === "5m" ? 5 * 60e3 : 3600e3;
  if (now - turn.t > ttlMs + 10_000) return null; // cold cache: coldCacheAdvice speaks instead

  // the model was resolved from the price list, so its rates exist
  const rates = /** @type {any} */ (ratesFor(pricing, model.key, { at: now, promptTokens: turn.ctx }));
  const start = Math.min(turn.baseTokens || 88_000, 100_000);
  const freshTokens = start + cfg.handoffTokens + cfg.rebuildTokens;
  const savedPerMessageUSD = ((turn.ctx - freshTokens) * rates.cacheRead) / 1e6;
  if (savedPerMessageUSD <= 0) return null;
  const growth = Math.max(turn.growthPerMessage, 1_000);
  const messagesLeft = Math.max(1, Math.min(cfg.resetHorizonMessages, Math.floor((0.95 * windowTokens - turn.ctx) / growth)));
  const savingUSD = savedPerMessageUSD * messagesLeft;
  if (savingUSD < cfg.resetMinSavingUSD) return null;

  const limit = fitLimits(calibration.points).fiveHourUSD;
  const pctOfLimit = limit ? (savingUSD / limit) * 100 : null;
  const level = pct >= cfg.resetAtPct + 20 ? 2 : 1;
  const message =
    `Your conversation is ~${fmtK(turn.ctx)} tokens (${Math.round(pct)}% of the window) and every message re-reads all of it. ` +
    `Claude Code only compacts near 95%; starting fresh now with a short handoff would save about ${usd(savingUSD)} over the next ~${messagesLeft} messages${pctOfLimit != null ? ` (about ${pctOfLimit < 1 ? "<1" : Math.round(pctOfLimit)}% of your 5-hour limit)` : ""} [estimated]. ` +
    `Finish the current step, then run \`sparelimit reset\` and /clear (or /compact with a focus).`;
  return { rule: "context.reset", level, message, evidence: { contextTokens: turn.ctx, windowTokens, contextPct: Number(pct.toFixed(1)), savedPerMessageUSD: Number(savedPerMessageUSD.toFixed(4)), messagesLeft, growthPerMessage: growth, savingUSD: Number(savingUSD.toFixed(2)), pctOfFiveHourLimit: pctOfLimit != null ? Number(pctOfLimit.toFixed(1)) : null, confidence: "estimated" } };
}
