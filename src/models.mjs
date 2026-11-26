import { priceEvent } from "./analyze.mjs";

/**
 * Model advisor (coach lever K4): which of the work done on the expensive models could run one tier down, and how risky is that?
 *
 * Each response is put in a task type by what it DID (the tools it called), because that is what a log shows; how hard the thinking
 * was is invisible. The risk tiers are a rule of thumb, not a measurement:
 *   low    = running commands, exploring/reading, driving a browser or other MCP tools (the model mostly chooses what to run next)
 *   medium = editing files, mixed tool use, handing work to a subagent (a wrong edit costs rework)
 *   high   = responses with no tool call: planning, explaining, deciding (where the stronger model earns its price)
 * The saving is a what-if on the real price table (estimated): the same tokens priced on the next tier down (Opus -> Sonnet 5.5,
 * Fable -> Opus 5.5). Evidence from the user's own history is shown beside it: how often tool calls failed on each model.
 */
export const RISK = { run: "low", explore: "low", mcp: "low", edit: "medium", mixed: "medium", delegate: "medium", think: "high" };
export const TARGET = { opus: "claude-sonnet-5-5", fable: "claude-opus-5-5" };

const family = (key = "") => (/fable/.test(key) ? "fable" : /opus/.test(key) ? "opus" : /sonnet/.test(key) ? "sonnet" : /haiku/.test(key) ? "haiku" : "other");
/**
 * @typedef {{ responses: number, usd: number, savingUSD: number, sideUSD: number }} TaskCell
 * @typedef {{ calls: number, errors: number }} ErrorCell
 * @typedef {{ tasks: Record<string, TaskCell>, errors: Record<string, Record<string, ErrorCell>> }} ModelReport
 */
const r2 = (/** @type {number} */ n) => Number(n.toFixed(2));

/** @param {any} ev */
export function taskType(ev) {
  /** @type {string[]} */
  const t = ev.tools || [];
  if (!t.length) return "think";
  if (t.some((x) => /^(Task|Agent)$/.test(x))) return "delegate";
  if (t.some((x) => /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(x))) return "edit";
  if (t.every((x) => /^(Read|Grep|Glob|LS|WebFetch|WebSearch|TodoWrite)$/.test(x))) return "explore";
  if (t.every((x) => x === "Bash")) return "run";
  if (t.some((x) => x.startsWith("mcp__"))) return "mcp";
  return "mixed";
}

/** Per session: spend and what-if saving by task type on the expensive models, and tool-call failure counts by model family. */
/** @param {any[]} priced @param {any} pricing @returns {ModelReport} */
export function modelReport(priced, pricing) {
  /** @type {Record<string, TaskCell>} */
  const tasks = {};
  /** @type {Record<string, Record<string, ErrorCell>>} */
  const errors = {};
  for (const x of priced) {
    const fam = family(x.key);
    const type = taskType(x.ev);
    const e = (errors[fam] ||= {});
    const calls = x.ev.calls || [];
    const cell = (e[type] ||= { calls: 0, errors: 0 });
    for (const c of calls) {
      if (c.res == null) continue; // result unknown
      cell.calls += 1;
      if (c.res.startsWith("!")) cell.errors += 1;
    }
    const target = /** @type {Record<string, string>} */ (TARGET)[fam];
    if (!target) continue;
    const t = (tasks[type] ||= { responses: 0, usd: 0, savingUSD: 0, sideUSD: 0 });
    const saving = Math.max(0, x.cost - priceEvent(x.ev, pricing, target).cost);
    t.responses += 1;
    t.usd += x.cost;
    t.savingUSD += saving;
    if (x.ev.isSidechain) t.sideUSD += x.cost;
  }
  for (const t of Object.values(tasks)) Object.assign(t, { usd: r2(t.usd), savingUSD: r2(t.savingUSD), sideUSD: r2(t.sideUSD) });
  return { tasks, errors };
}

/** Across sessions: totals by task type and risk tier, failure rates by model, and Opus-family spend by subagent type. */
/** @param {ModelReport[]} reports @param {any[]} [delegations] */
export function summarizeModels(reports, delegations = []) {
  /** @type {Record<string, TaskCell>} */
  const tasks = {};
  /** @type {Record<string, Record<string, ErrorCell>>} */
  const errors = {};
  for (const r of reports) {
    for (const [k, v] of Object.entries(r.tasks)) {
      const t = (tasks[k] ||= { responses: 0, usd: 0, savingUSD: 0, sideUSD: 0 });
      for (const f of /** @type {(keyof TaskCell)[]} */ (Object.keys(t))) t[f] += v[f];
    }
    for (const [fam, byType] of Object.entries(r.errors)) for (const [k, v] of Object.entries(byType)) {
      const c = ((errors[fam] ||= {})[k] ||= { calls: 0, errors: 0 });
      c.calls += v.calls;
      c.errors += v.errors;
    }
  }
  const rows = Object.entries(tasks).map(([type, t]) => ({ type, risk: /** @type {Record<string, string>} */ (RISK)[type], ...t, usd: r2(t.usd), savingUSD: r2(t.savingUSD), sideUSD: r2(t.sideUSD) })).sort((a, b) => b.savingUSD - a.savingUSD);
  const tier = (/** @type {string} */ risk) => r2(rows.filter((x) => x.risk === risk).reduce((n, x) => n + x.savingUSD, 0));
  const expensiveUSD = r2(rows.reduce((n, x) => n + x.usd, 0));
  const rate = (/** @type {string} */ fam, /** @type {string} */ type) => {
    const c = errors[fam]?.[type];
    return c && c.calls >= 50 ? { calls: c.calls, failedPct: Number(((c.errors / c.calls) * 100).toFixed(1)) } : null;
  };
  const evidence = ["run", "edit"].map((type) => ({ type, opus: rate("opus", type), sonnet: rate("sonnet", type) })).filter((x) => x.opus && x.sonnet);
  /** @type {Record<string, { agents: number, usd: number, expensiveUSD: number }>} */
  const byAgent = {};
  for (const d of delegations.flat()) {
    const a = (byAgent[d.type] ||= { agents: 0, usd: 0, expensiveUSD: 0 });
    a.agents += 1;
    a.usd += d.costUSD;
    if (/opus|fable/.test(d.model || "")) a.expensiveUSD += d.costUSD;
  }
  const subagentTypes = Object.entries(byAgent).map(([type, a]) => ({ type, agents: a.agents, usd: r2(a.usd), expensiveUSD: r2(a.expensiveUSD) })).sort((a, b) => b.expensiveUSD - a.expensiveUSD);
  return { expensiveUSD, rows, tierSavingUSD: { low: tier("low"), medium: tier("medium"), high: tier("high") }, evidence, subagentTypes, confidence: "estimated: same tokens priced one tier down; quality is not measured" };
}
