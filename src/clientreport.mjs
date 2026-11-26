import path from "node:path";
import { clientOf, encodeProject } from "./clients.mjs";
import { projectLabel } from "./sources.mjs";
import { priceEvent } from "./analyze.mjs";

/**
 * Client report (E4): what one client's work used over a period, as a page that can be sent: spend by week, by project and by agent. It is
 * built from the same logs as every other view, so the dollars are API-equivalent at list price (derived), not an invoice. It carries no
 * prompt text and no paths; `hideProjects` leaves project names out too. Claude Code sessions are matched to the client by the folder name
 * Claude Code logs, Codex sessions by the working directory they record (encoded the same way), using the rules of `sparelimit clients`.
 */
const DAY = 86400e3;
const r2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;
const esc = (/** @type {any} */ t) => String(t).replace(/[&<>"']/g, (c) => /** @type {Record<string, string>} */ ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const usd = (/** @type {number} */ n) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Monday 00:00 UTC of the week holding t. */
export const weekStart = (/** @type {any} */ t) => {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
};

/**
 * @param {{ claudeResults?: any[], codexSessions?: any[], rules: any[], client: string, days?: number, now?: number, pricing?: any, hideProjects?: boolean, budget?: { period: string, spentUSD: number, limitUSD: number, pct: number, over: boolean }[] | null }} o
 */
export function buildClientReport({ claudeResults = [], codexSessions = [], rules, client, days = 30, now = Date.now(), pricing, hideProjects = false, budget = null }) {
  const since = now - days * DAY;
  const weeks = new Map();
  const projects = new Map();
  /** @type {Record<string, { usd: number, sessions: number }>} */
  const agents = { claude: { usd: 0, sessions: 0 }, codex: { usd: 0, sessions: 0 }, gemini: { usd: 0, sessions: 0 } };
  const active = new Set();
  const add = (/** @type {any} */ agent, /** @type {any} */ project, /** @type {any} */ t, /** @type {any} */ cost) => {
    if (t < since || t > now || !(cost > 0)) return;
    const w = weekStart(t);
    weeks.set(w, (weeks.get(w) || 0) + cost);
    const p = projects.get(project) || { project, usd: 0, agents: new Set() };
    p.usd += cost;
    p.agents.add(agent);
    projects.set(project, p);
    agents[agent].usd += cost;
  };

  for (const r of claudeResults) {
    const dirName = path.basename(String(r.project || ""));
    if (clientOf(dirName, rules) !== client) continue;
    let used = false;
    for (const e of r.timeline || []) {
      if (e.t >= since && e.t <= now && e.cost > 0) used = true;
      add("claude", projectLabel(dirName), e.t, e.cost);
    }
    if (used) {
      agents.claude.sessions += 1;
      active.add(`c:${r.sessionId}`);
    }
  }
  for (const s of codexSessions) {
    if (!s.projectDir || clientOf(encodeProject(s.projectDir), rules) !== client) continue;
    let used = false;
    const agent = s.agent === "gemini" ? "gemini" : "codex"; // `codexSessions` holds the sessions of the other agents (Codex CLI, Gemini CLI)
    for (const ev of s.events) {
      const t = Date.parse(ev.ts);
      const cost = priceEvent(ev, pricing).cost;
      if (t >= since && t <= now && cost > 0) used = true;
      add(agent, path.basename(s.projectDir), t, cost);
    }
    if (used && !s.subagent) {
      // a subagent's spend is the client's, but it is part of a conversation, not a working session of its own
      agents[agent].sessions += 1;
      active.add(`${agent === "gemini" ? "g" : "x"}:${s.sessionId}`);
    }
  }

  const total = [...weeks.values()].reduce((n, x) => n + x, 0);
  const rows = [...projects.values()].sort((a, b) => b.usd - a.usd);
  const weekRows = [...weeks].sort((a, b) => a[0] - b[0]).map(([w, v]) => ({ weekStart: new Date(w).toISOString().slice(0, 10), usd: r2(v) }));
  return {
    client,
    periodDays: days,
    from: new Date(since).toISOString().slice(0, 10),
    to: new Date(now).toISOString().slice(0, 10),
    generated: new Date(now).toISOString().slice(0, 10),
    totalUSD: r2(total),
    sessions: active.size,
    projects: rows.length,
    weeks: weekRows,
    byAgent: { claude: { usd: r2(agents.claude.usd), sessions: agents.claude.sessions }, codex: { usd: r2(agents.codex.usd), sessions: agents.codex.sessions }, ...(agents.gemini.usd > 0 ? { gemini: { usd: r2(agents.gemini.usd), sessions: agents.gemini.sessions } } : {}) },
    topProjects: hideProjects ? [] : rows.slice(0, 10).map((p) => ({ project: p.project, usd: r2(p.usd), sharePct: total ? Math.round((p.usd / total) * 1000) / 10 : 0, agents: [...p.agents].sort() })),
    hideProjects,
    budget: budget && budget.length ? budget : null,
    note: "Dollars are API-equivalent at list price: what the same tokens would cost at public API prices. They show how much of the work a client's projects used, not what anyone was billed."
  };
}

const COLORS = { fg: "#0a1230", muted: "#4a5878", blue: "#1f4bff", line: "#d5dcf2", bg: "#ffffff", soft: "#f4f7ff" };

function weekChart(/** @type {any} */ weeks) {
  if (!weeks.length) return "";
  const W = 760;
  const H = 180;
  const pad = 36;
  const max = Math.max(...weeks.map((/** @type {any} */ w) => w.usd), 1);
  const bw = Math.min(70, (W - pad * 2) / weeks.length - 10);
  const bars = weeks.map((/** @type {any} */ w, /** @type {any} */ i) => {
    const x = pad + i * ((W - pad * 2) / weeks.length) + 5;
    const h = Math.max(2, (w.usd / max) * (H - 50));
    return `<rect x="${x.toFixed(1)}" y="${(H - 28 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${COLORS.blue}"/><text x="${(x + bw / 2).toFixed(1)}" y="${(H - 32 - h).toFixed(1)}" text-anchor="middle" font-size="11" fill="${COLORS.fg}">${esc(usd(w.usd).replace(/\.\d\d$/, ""))}</text><text x="${(x + bw / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="${COLORS.muted}">${esc(w.weekStart.slice(5))}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Spend per week, from ${esc(weeks[0].weekStart)}">${bars}</svg>`;
}

export function renderClientReportHtml(/** @type {any} */ r) {
  const agents = Object.entries(r.byAgent).filter(([, v]) => v.usd > 0).map(([k, v]) => `${k === "claude" ? "Claude Code" : k === "gemini" ? "Gemini CLI" : "Codex"}: ${usd(v.usd)} (${v.sessions} sessions)`).join(" &middot; ");
  const projects = r.hideProjects
    ? `<p class="muted">Project names are left out of this report.</p>`
    : r.topProjects.length
      ? `<table><thead><tr><th>Project</th><th class="n">Spend</th><th class="n">Share</th></tr></thead><tbody>${r.topProjects.map((/** @type {any} */ p) => `<tr><td>${esc(p.project)}</td><td class="n">${esc(usd(p.usd))}</td><td class="n">${p.sharePct < 0.5 ? "&lt;1" : esc(Math.round(p.sharePct))}%</td></tr>`).join("")}</tbody></table>`
      : `<p class="muted">No activity in this period.</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(r.client)}: AI coding report, ${esc(r.from)} to ${esc(r.to)}</title>
<style>
:root{color-scheme:light}body{margin:0;background:${COLORS.bg};color:${COLORS.fg};font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:820px;margin:0 auto;padding:40px 24px 56px}h1{font-size:30px;line-height:1.2;margin:0 0 4px}h2{font-size:18px;margin:32px 0 8px}
.muted{color:${COLORS.muted}}.tiles{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0}.tile{flex:1 1 150px;background:${COLORS.soft};border:1px solid ${COLORS.line};border-radius:10px;padding:12px 16px}
.tile b{display:block;font-size:24px}table{border-collapse:collapse;width:100%;font-size:15px}th,td{border-top:1px solid ${COLORS.line};padding:8px 10px 8px 0;text-align:left}th{border-top:0;color:${COLORS.muted};font-weight:600}.n{text-align:right;white-space:nowrap}
footer{margin-top:36px;padding-top:12px;border-top:1px solid ${COLORS.line};font-size:13px;color:${COLORS.muted}}
@media print{main{padding:0}.tile{break-inside:avoid}h2{break-after:avoid}}
</style></head>
<body><main>
<h1>${esc(r.client)}</h1>
<p class="muted">AI coding usage, ${esc(r.from)} to ${esc(r.to)} (${esc(r.periodDays)} days). Prepared ${esc(r.generated)}.</p>
<div class="tiles"><div class="tile"><b>${esc(usd(r.totalUSD))}</b>at list price</div><div class="tile"><b>${esc(r.sessions)}</b>working sessions</div><div class="tile"><b>${esc(r.projects)}</b>projects</div></div>
${agents ? `<p>${agents}</p>` : ""}
${r.budget ? `<h2>Budget</h2><table><thead><tr><th>Period</th><th class="n">Spent</th><th class="n">Budget</th><th class="n">Used</th></tr></thead><tbody>${r.budget.map((/** @type {any} */ b) => `<tr><td>${esc(b.period)}</td><td class="n">${esc(usd(b.spentUSD))}</td><td class="n">${esc(usd(b.limitUSD))}</td><td class="n">${esc(b.pct)}%${b.over ? " (over)" : ""}</td></tr>`).join("")}</tbody></table>` : ""}
<h2>By week</h2>${r.weeks.length ? weekChart(r.weeks) : `<p class="muted">No activity in this period.</p>`}
<h2>By project</h2>${projects}
<footer>${esc(r.note)} Made with Sparelimit from local session logs; it contains no prompts and no file paths.</footer>
</main></body></html>
`;
}
