import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data");
const readJson = (/** @type {any} */ p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Load the bundled LiteLLM snapshot, then the bundled effective-dated overrides, then the user's
 * overrides (~/.sparelimit/pricing.json, same shape). Rates are USD per 1M tokens.
 */
export function loadPricing({ userOverridesPath = path.join(process.env.SPARELIMIT_HOME || path.join(os.homedir(), ".sparelimit"), "pricing.json") } = {}) {
  const snap = readJson(path.join(DATA_DIR, "pricing.snapshot.json")) || { models: {}, generatedAt: "unknown" };
  const overrides = [readJson(path.join(DATA_DIR, "pricing.overrides.json")), readJson(userOverridesPath)].filter(Boolean);
  return { models: snap.models, generatedAt: snap.generatedAt, source: snap.source, overrides };
}

/** Map an agent's model name ("claude-sonnet-4-5-20250929", "Gemini 3.8 Flash (High)", "x[1m]") to a table key. */
export function resolveModel(/** @type {any} */ pricing, /** @type {string} */ id) {
  if (!id) return null;
  let k = String(id).toLowerCase().trim().replace(/\[.*?\]/g, "").replace(/\(.*?\)/g, "").trim().replace(/\s+/g, "-");
  const dashed = k.replace(/(\d)\.(\d)/g, "$1-$2"); // "Claude Sonnet 5.5" -> claude-sonnet-5-5
  const tries = [k, k.replace(/-\d{8}$/, ""), k.replace(/-latest$/, ""), dashed, dashed.replace(/-\d{8}$/, "")];
  for (const t of tries) if (pricing.models[t]) return { key: t, entry: pricing.models[t] };
  return null;
}

/**
 * Effective rates for one request: base rates, then any dated schedule entries on/before `at`,
 * then the prompt-length tier (the whole request is billed at the higher tier once over the threshold).
 */
/**
 * @param {any} pricing
 * @param {string} key
 * @param {{ at?: Date | number | string, promptTokens?: number }} [opts]
 */
export function ratesFor(pricing, key, { at = new Date(), promptTokens = 0 } = {}) {
  const base = pricing.models[key];
  if (!base) return null;
  const date = (at instanceof Date ? at : new Date(at)).toISOString().slice(0, 10);
  let rates = { input: base.input, output: base.output, cacheRead: base.cacheRead, cacheWrite5m: base.cacheWrite5m, cacheWrite1h: base.cacheWrite1h };
  let tier = base.tier;
  for (const file of pricing.overrides) {
    const o = file[key];
    if (!o) continue;
    const { schedule = [], ...flat } = o;
    rates = { ...rates, ...pickRates(flat) };
    for (const s of schedule.filter((/** @type {any} */ x) => x.from <= date).sort((/** @type {any} */ a, /** @type {any} */ b) => a.from.localeCompare(b.from))) rates = { ...rates, ...pickRates(s) };
  }
  if (tier && promptTokens > tier.aboveTokens) rates = { ...rates, ...pickRates(tier) };
  // Providers without a separate write price bill cache writes as normal input.
  rates.cacheRead ??= rates.input;
  rates.cacheWrite5m ??= rates.input;
  rates.cacheWrite1h ??= rates.cacheWrite5m;
  return rates;
}

const pickRates = (/** @type {any} */ o) => Object.fromEntries(["input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h"].filter((k) => o[k] != null).map((k) => [k, o[k]]));

/** USD cost of one usage object at the given rates (per-MTok). */
export function costUSD(/** @type {any} */ rates, /** @type {any} */ usage) {
  const M = 1e6;
  return (
    (usage.input * rates.input + usage.cacheRead * rates.cacheRead + usage.cacheWrite5m * rates.cacheWrite5m + usage.cacheWrite1h * rates.cacheWrite1h + usage.output * rates.output) / M
  );
}

/**
 * B7: is the bundled price snapshot old, and are any models you used past, or close to, their deprecation date? `used` is a list of model
 * ids from recent sessions. A deprecation date comes from the price list and says when the provider retires the model; Sparelimit keeps
 * pricing it. `staleAfterDays` is the age at which the snapshot should be refreshed (`npm run update-pricing`).
 */
/**
 * @param {any} pricing
 * @param {{ used?: string[], now?: number, staleAfterDays?: number, soonDays?: number }} [opts]
 */
export function pricingHealth(pricing, { used = [], now = Date.now(), staleAfterDays = 45, soonDays = 60 } = {}) {
  const gen = Date.parse(pricing.generatedAt);
  const ageDays = Number.isFinite(gen) ? Math.floor((now - gen) / 86400e3) : null;
  const seen = new Set();
  const deprecated = [];
  for (const id of used) {
    const hit = resolveModel(pricing, id);
    const key = hit?.key;
    const entry = hit?.entry;
    if (!entry?.deprecationDate || seen.has(key)) continue;
    seen.add(key);
    const days = Math.round((Date.parse(entry.deprecationDate) - now) / 86400e3);
    if (days <= soonDays) deprecated.push({ model: key, date: entry.deprecationDate, daysLeft: days, past: days < 0 });
  }
  deprecated.sort((a, b) => a.daysLeft - b.daysLeft);
  return { ageDays, stale: ageDays == null || ageDays > staleAfterDays, deprecated };
}
