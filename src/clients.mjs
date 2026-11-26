import path from "node:path";
import { periodStarts, PERIODS } from "./budget.mjs";
import { priceEvent } from "./analyze.mjs";

/**
 * Clients (I3, for agencies): which client's work a session was. A rule maps a project folder to a client label; the first rule that matches
 * wins; sessions no rule matches are "Unassigned", and the report lists their largest projects so the next rule is easy to write.
 *
 *   { "path": "/Users/me/Clients/Acme", "label": "Acme" }      the folder and anything whose name starts the same
 *   { "contains": "acme", "label": "Acme" }                    any project whose folder name contains the text (not case-sensitive)
 *
 * Claude Code names a project's log folder after its working directory with every character that is not a letter or digit turned into a
 * dash, so a path cannot be told from a name that merely starts the same way ("/x/Acme" also matches "/x/Acme-site"); the rules are matched
 * on that encoded name. Dollars are API-equivalent at list price (derived).
 */
/** @param {any} s */
export const encodeProject = (s) => String(s).replace(/[^A-Za-z0-9]/g, "-");

/** Budgets per client: { "Acme": { dailyUSD, weeklyUSD, monthlyUSD } }, positive numbers only; a client with none left is dropped. */
/** @param {any} b */
export function sanitizeClientBudgets(b) {
  /** @type {Record<string, Record<string, number>>} */
  const out = {};
  if (!b || typeof b !== "object") return out;
  for (const [label, v] of Object.entries(b)) {
    if (!label.trim() || label.length > 60 || !v || typeof v !== "object") continue;
    /** @type {Record<string, number>} */
    const one = {};
    for (const k of ["dailyUSD", "weeklyUSD", "monthlyUSD"]) if (typeof v[k] === "number" && Number.isFinite(v[k]) && v[k] > 0) one[k] = v[k];
    if (Object.keys(one).length) out[label.trim()] = one;
  }
  return out;
}

/**
 * @param {any} c
 * @returns {{ rules: { path?: string, contains?: string, label: string }[], budgets: Record<string, Record<string, number>> }}
 */
export function sanitizeClients(c) {
  /** @type {{ path?: string, contains?: string, label: string }[]} */
  const rules = [];
  for (const r of Array.isArray(c?.rules) ? c.rules : []) {
    if (!r || typeof r.label !== "string" || !r.label.trim() || r.label.length > 60) continue;
    const label = r.label.trim();
    if (typeof r.path === "string" && path.isAbsolute(r.path) && r.path.length < 400) rules.push({ path: r.path, label });
    else if (typeof r.contains === "string" && r.contains.trim().length >= 2 && r.contains.length <= 80) rules.push({ contains: r.contains.trim(), label });
  }
  return { rules, budgets: sanitizeClientBudgets(c?.budgets) };
}

/** The client for a project folder name (the encoded one), or null. */
/**
 * @param {any} projectName
 * @param {{ path?: string, contains?: string, label: string }[]} rules
 */
export function clientOf(projectName, rules) {
  const name = String(projectName || "");
  const lower = name.toLowerCase();
  for (const r of rules) {
    if (r.path && name.startsWith(encodeProject(path.resolve(r.path)))) return r.label;
    if (r.contains && lower.includes(encodeProject(r.contains).toLowerCase())) return r.label;
  }
  return null;
}

const DAY = 86400e3;

/**
 * @param {any[]} results
 * @param {{ path?: string, contains?: string, label: string }[]} rules
 * @param {{ now?: number }} [opts]
 */
export function summarizeClients(results, rules, { now = Date.now() } = {}) {
  const rows = new Map();
  const unassigned = new Map();
  for (const r of results) {
    const name = path.basename(String(r.project || ""));
    const label = clientOf(name, rules) || "Unassigned";
    const x = rows.get(label) || rows.set(label, { label, sessions: 0, totalUSD: 0, last7DaysUSD: 0, last30DaysUSD: 0, projects: new Set() }).get(label);
    x.sessions += 1;
    x.totalUSD += r.totalCostUSD || 0;
    x.projects.add(name);
    for (const e of r.timeline || []) {
      if (e.t >= now - 7 * DAY) x.last7DaysUSD += e.cost;
      if (e.t >= now - 30 * DAY) x.last30DaysUSD += e.cost;
    }
    if (label === "Unassigned") unassigned.set(name, (unassigned.get(name) || 0) + (r.totalCostUSD || 0));
  }
  const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;
  const clients = [...rows.values()].map(({ projects, ...x }) => ({ ...x, projects: projects.size, totalUSD: r2(x.totalUSD), last7DaysUSD: r2(x.last7DaysUSD), last30DaysUSD: r2(x.last30DaysUSD) }));
  clients.sort((a, b) => Number(a.label === "Unassigned") - Number(b.label === "Unassigned") || b.totalUSD - a.totalUSD);
  return {
    clients,
    unassignedTop: [...unassigned].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([project, usd]) => ({ project, usd: r2(usd) })),
    rules: rules.length,
    note: "Dollars are API-equivalent at list price (derived). A session goes to the first rule that matches its project folder; the rest are Unassigned."
  };
}

/**
 * Every response's time and cost per client, Claude Code and Codex together, for budgets: { "Acme": [{ t, cost }] }. Claude sessions are
 * matched by the folder name Claude Code logs, Codex sessions by the working directory they record, with the same rules. Sessions no rule
 * matches are left out (a budget belongs to a named client).
 */
/**
 * @param {{ claudeResults?: any[], codexSessions?: any[], rules: { path?: string, contains?: string, label: string }[], pricing: any }} p
 * @returns {Map<string, { t: number, cost: number }[]>}
 */
export function clientEvents({ claudeResults = [], codexSessions = [], rules, pricing }) {
  /** @type {Map<string, { t: number, cost: number }[]>} */
  const out = new Map();
  /** @param {string} label @param {number} t @param {number} cost */
  const push = (label, t, cost) => {
    if (!(cost > 0)) return;
    let list = out.get(label);
    if (!list) out.set(label, (list = []));
    list.push({ t, cost });
  };
  for (const r of claudeResults) {
    const label = clientOf(path.basename(String(r.project || "")), rules);
    if (label) for (const e of r.timeline || []) push(label, e.t, e.cost);
  }
  for (const s of codexSessions) {
    const label = s.projectDir ? clientOf(encodeProject(s.projectDir), rules) : null;
    if (label) for (const ev of s.events) push(label, Date.parse(ev.ts), priceEvent(ev, pricing).cost);
  }
  return out;
}

/** Spend against each client's budgets over the local calendar (today, the week from Monday, the month from the 1st). */
/**
 * @param {Map<string, { t: number, cost: number }[]>} events
 * @param {Record<string, Record<string, number>>} budgets
 */
export function checkClientBudgets(events, budgets, now = Date.now()) {
  const starts = periodStarts(now);
  const clients = Object.keys(budgets).map((label) => {
    const evs = events.get(label) || [];
    const rows = PERIODS.filter(([key]) => budgets[label][key] != null).map(([key, name]) => {
      const spent = evs.reduce((n, e) => (e.t >= /** @type {Record<string, number>} */ (starts)[key] && e.t <= now ? n + e.cost : n), 0);
      const limit = budgets[label][key];
      return { key, period: name, spentUSD: Math.round(spent * 100) / 100, limitUSD: limit, pct: Math.round((spent / limit) * 100), over: spent > limit };
    });
    return { label, rows, over: rows.filter((r) => r.over).map((r) => r.period) };
  });
  return { clients, overAny: clients.some((c) => c.over.length > 0), note: "Dollars are API-equivalent at list price (derived). The periods are the local calendar. A budget is a pace limit on a subscription, not a bill." };
}
