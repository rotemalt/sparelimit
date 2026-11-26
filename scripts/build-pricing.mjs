#!/usr/bin/env node
// Build data/pricing.snapshot.json (a trimmed, per-MTok view) from LiteLLM's price list.
//   node scripts/build-pricing.mjs <path-or-url-to-model_prices_and_context_window.json> [out]
// Source: https://github.com/BerriAI/litellm (community maintained; spot-check against official pages each release).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const src = process.argv[2];
if (!src) {
  console.error("usage: build-pricing.mjs <litellm json path|url> [out]");
  process.exit(1);
}
const out = process.argv[3] || path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "pricing.snapshot.json");
const raw = /^https?:/.test(src) ? await (await fetch(src)).text() : fs.readFileSync(src, "utf8");
const all = JSON.parse(raw);

const KEEP = /^(claude-|gemini-|gpt-|o[1-9](-|$)|codex-|deepseek-|grok-)/;
const SKIP = /(tts|live|image|audio|transcribe|embedding|realtime|search-preview|moderation|computer-use-preview)/;
const M = 1e6;
const r = (x) => (x == null ? undefined : Number((x * M).toPrecision(6)));
const models = {};
for (const [key, v] of Object.entries(all)) {
  if (key.includes("/") || !KEEP.test(key) || SKIP.test(key)) continue;
  if (!["chat", "responses", "completion"].includes(v.mode)) continue;
  if (v.input_cost_per_token == null || v.output_cost_per_token == null) continue;
  const e = {
    provider: v.litellm_provider,
    input: r(v.input_cost_per_token),
    output: r(v.output_cost_per_token),
    cacheRead: r(v.cache_read_input_token_cost),
    cacheWrite5m: r(v.cache_creation_input_token_cost),
    cacheWrite1h: r(v.cache_creation_input_token_cost_above_1hr),
    maxInput: v.max_input_tokens,
    deprecationDate: v.deprecation_date
  };
  // Prompt-length tier: the whole request is priced at the higher rate once the prompt exceeds the threshold.
  const t = Object.keys(v).map((k) => k.match(/^input_cost_per_token_above_(\d+)k_tokens$/)).find(Boolean);
  if (t) {
    const s = `_above_${t[1]}k_tokens`;
    e.tier = {
      aboveTokens: Number(t[1]) * 1000,
      input: r(v[`input_cost_per_token${s}`]),
      output: r(v[`output_cost_per_token${s}`]),
      cacheRead: r(v[`cache_read_input_token_cost${s}`]),
      cacheWrite5m: r(v[`cache_creation_input_token_cost${s}`]),
      cacheWrite1h: r(v[`cache_creation_input_token_cost_above_1hr${s}`])
    };
  }
  models[key] = JSON.parse(JSON.stringify(e)); // drop undefined
}
const snapshot = { _schema: "sparelimit-pricing-v1", unit: "USD per 1M tokens", source: "BerriAI/litellm model_prices_and_context_window.json", generatedAt: new Date().toISOString().slice(0, 10), models };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(snapshot));
console.log(`wrote ${out}: ${Object.keys(models).length} models, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
