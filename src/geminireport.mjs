import path from "node:path";
import { priceEvent } from "./analyze.mjs";

/**
 * What Gemini CLI sessions cost (A8): spend, tokens by class, spend by model and by day, and the largest sessions, from the parsed sessions.
 * Token counts are the CLI's own; dollars are API-equivalent at list price (derived). The mapping of "thoughts" to output and "tool" to input
 * is an assumption (see the adapter), and a model that is not in the price list (a preview name, for instance) is priced at the default and
 * counted apart (estimated). The coaching views are NOT applied: their rules (cache lifetime, model families) are Claude's.
 */
const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;

/**
 * @param {any[]} sessions parsed Gemini sessions
 * @param {{ pricing?: any, now?: number }} [opts]
 */
export function summarizeGemini(sessions, { pricing, now = Date.now() } = {}) {
  /** @type {Map<string, { model: string, responses: number, usd: number, priced: boolean }>} */
  const byModel = new Map();
  /** @type {Map<string, number>} */
  const byDay = new Map();
  /** @type {{ id: string, project: string | null, start: string, responses: number, totalUSD: number }[]} */
  const rows = [];
  const tok = { input: 0, cacheRead: 0, output: 0 };
  let total = 0;
  let estimated = 0;
  let responses = 0;
  let sessionsWithUsage = 0;
  for (const s of sessions) {
    if (!s.events.length) continue;
    sessionsWithUsage += 1;
    let cost = 0;
    for (const ev of s.events) {
      const p = priceEvent(ev, pricing);
      cost += p.cost;
      total += p.cost;
      if (p.unpriced) estimated += p.cost;
      responses += 1;
      tok.input += ev.usage.input;
      tok.cacheRead += ev.usage.cacheRead;
      tok.output += ev.usage.output;
      const key = ev.model || "unknown";
      const m = byModel.get(key) || { model: key, responses: 0, usd: 0, priced: !p.unpriced };
      m.responses += 1;
      m.usd += p.cost;
      byModel.set(key, m);
      const day = new Date(ev.ts).toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + p.cost);
    }
    rows.push({ id: s.sessionId, project: s.projectDir ? path.basename(s.projectDir) : null, start: s.events[0].ts, responses: s.events.length, totalUSD: r2(cost) });
  }
  const all = tok.input + tok.cacheRead + tok.output;
  const since = new Date(now - 14 * 86400e3).toISOString().slice(0, 10);
  return {
    sessions: sessionsWithUsage,
    sessionsWithoutUsage: sessions.length - sessionsWithUsage,
    responses,
    totalUSD: r2(total),
    estimatedUSD: r2(estimated),
    tokens: { ...tok, total: all, cacheReadShare: all ? Math.round((tok.cacheRead / all) * 100) : 0 },
    byModel: [...byModel.values()].map((m) => ({ ...m, usd: r2(m.usd) })).sort((a, b) => b.usd - a.usd),
    last14Days: [...byDay.entries()].filter(([d]) => d >= since).sort((a, b) => a[0].localeCompare(b[0])).map(([day, usd]) => ({ day, usd: r2(usd) })),
    top: rows.sort((a, b) => b.totalUSD - a.totalUSD).slice(0, 10),
    confidence: "derived",
    note: "Token counts are the CLI's own. Dollars are API-equivalent at list price (derived). Thinking tokens are priced as output and tool-use prompt tokens as input, which is an assumption read from the log's totals. A model missing from the price list (a preview name) is priced at the default and shown as estimated. Sessions without usage records (the CLI's background server sessions) are counted apart."
  };
}
