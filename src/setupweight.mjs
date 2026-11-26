import fs from "node:fs";
import { parseTranscript, readJsonl } from "./adapters/index.mjs";
import { priceEvent } from "./analyze.mjs";
import { loadPricing } from "./pricing.mjs";

const CHARS_PER_TOKEN = 3.7; // rough; the report also shows the measured size for comparison
const tok = (/** @type {number} */ chars) => Math.round(chars / CHARS_PER_TOKEN);
const text = (/** @type {any} */ m) => (typeof m?.content === "string" ? m.content : Array.isArray(m?.content) ? m.content.map((/** @type {any} */ c) => c.text || "").join("\n") : "");

/**
 * Split the first messages into sections using the markers Claude Code itself writes (not every markdown heading: a CLAUDE.md has
 * its own headings and must stay one block). Each section gets a kind.
 */
/**
 * @typedef {{ label: string, kind: string, chars: number, lines: number, items: number }} Section
 */
/** @param {string} t @returns {Section[]} */
export function sectionsOf(t) {
  /** @type {Section[]} */
  const out = [];
  let cur = { label: "(other)", kind: "Other" };
  /** @type {string[]} */
  let buf = [];
  const flush = () => {
    const body = buf.join("\n");
    const bullets = buf.filter((l) => /^- /.test(l)).length;
    const names = buf.filter((l) => l.trim()).length - 1; // deferred tool names are one per line, without a bullet
    if (body.trim()) out.push({ label: cur.label, kind: cur.kind, chars: body.length, lines: buf.length, items: cur.kind === "Deferred tool names" ? Math.max(0, names) : bullets });
    buf = [];
  };
  const start = (/** @type {string} */ label, /** @type {string} */ kind) => {
    flush();
    cur = { label: label.slice(0, 80), kind };
  };
  for (const line of t.split("\n")) {
    let m;
    if ((m = line.match(/^Contents of (.+?) \(/))) start(m[1], "Your instructions (CLAUDE.md files)");
    else if (/^# MCP Server Instructions/.test(line)) start("MCP server instructions", "MCP server instructions");
    else if (cur.kind === "MCP server instructions" && (m = line.match(/^## (.+)/))) start(m[1], "MCP server instructions");
    else if (/^The following skills are available/.test(line)) start("Skills listing", "Skills listing");
    else if (/^Available agent types/.test(line)) start("Agent types listing", "Agent types listing");
    else if (/^The following deferred tools/.test(line)) start("Deferred tool names", "Deferred tool names");
    else if (/^# Environment/.test(line)) start("Environment", "Environment");
    else if (/^# (?!#)/.test(line) && cur.kind !== "Your instructions (CLAUDE.md files)") start(line.replace(/^# /, ""), "Other");
    else if (/^<\/system-reminder>/.test(line) && cur.kind === "Your instructions (CLAUDE.md files)") start("(after instructions)", "Other");
    buf.push(line);
  }
  flush();
  return out;
}

/** Everything sent before the first prompt of a session, itemized, from the request shape Claude Code records in the transcript. */
/** @param {string} filePath */
export function analyzeSetup(filePath) {
  const objs = readJsonl(filePath);
  const shape = objs.find((o) => o.type === "api-request-shape")?.shape;
  const first = objs.find((o) => o.type === "api-request" && !o.base);
  if (!shape || !first) return { available: false, reason: "This session's log has no request-shape records (an older Claude Code version). Try a session from the last few weeks." };
  const blobs = new Map(objs.filter((/** @type {any} */ o) => o.type === "api-request-blob").map((o) => [o.hash, o.message]));

  /** @type {{ label: string, chars: number }[]} */
  const system = (shape.system || []).map((/** @type {any} */ b) => ({ label: String(b.text || "").replace(/\s+/g, " ").slice(0, 70), chars: String(b.text || "").length }));
  /** @type {{ name: string, chars: number }[]} */
  const toolItems = (shape.tools || []).map((/** @type {any} */ t) => ({ name: t.name, chars: JSON.stringify(t).length }));
  /** @type {Record<string, { chars: number, count: number }>} */
  const groups = {};
  for (const t of toolItems) {
    const server = t.name.startsWith("mcp__") ? t.name.split("__")[1] : "Claude Code built-in";
    groups[server] ||= { chars: 0, count: 0 };
    groups[server].chars += t.chars;
    groups[server].count += 1;
  }

  const messages = [];
  /** @type {Section[]} */
  const sections = [];
  for (const h of first.tail || []) {
    const m = blobs.get(h);
    if (!m) continue;
    const t = text(m);
    messages.push({ role: m.role, chars: t.length });
    for (const sec of sectionsOf(t)) sections.push(sec);
  }
  /** @type {Record<string, number>} */
  const byKind = {};
  for (const s of sections) byKind[s.kind] = (byKind[s.kind] || 0) + s.chars;

  const total = system.reduce((n, s) => n + s.chars, 0) + toolItems.reduce((n, t) => n + t.chars, 0) + messages.reduce((n, m) => n + m.chars, 0);
  const claudeMdFiles = sections.filter((s) => s.kind === "Your instructions (CLAUDE.md files)").map((s) => ({ file: s.label, tokens: tok(s.chars), lines: s.lines }));
  const itemsOf = (/** @type {string} */ kind) => sections.filter((s) => s.kind === kind).reduce((n, s) => n + s.items, 0);

  // measured: the context size of the first response, and what carrying the starting context cost over the whole session
  let measured = null;
  let startCostUSD = 0;
  let totalCostUSD = 0;
  let responses = 0;
  const s = parseTranscript(filePath);
  if (s) {
    const pricing = loadPricing();
    const main = s.events.filter((e) => !e.isSidechain && e.ts).sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    measured = main[0]?.context ?? null;
    responses = main.length;
    const start = tok(total);
    for (const e of s.events) totalCostUSD += priceEvent(e, pricing).cost;
    for (const e of main) startCostUSD += (start * priceEvent(e, pricing).rates.cacheRead) / 1e6;
  }
  return {
    available: true,
    totals: { tokens: tok(total), measuredFirstResponseTokens: measured, responses, startCostUSD: Number(startCostUSD.toFixed(2)), sessionCostUSD: Number(totalCostUSD.toFixed(2)), shareOfSessionCost: totalCostUSD ? Number(((startCostUSD / totalCostUSD) * 100).toFixed(1)) : null },
    system: system.map((x) => ({ ...x, tokens: tok(x.chars) })),
    tools: { count: toolItems.length, tokens: tok(toolItems.reduce((n, t) => n + t.chars, 0)), groups: Object.entries(groups).map(([server, v]) => ({ server, count: v.count, tokens: tok(v.chars) })).sort((a, b) => b.tokens - a.tokens), heaviest: toolItems.sort((a, b) => b.chars - a.chars).slice(0, 5).map((t) => ({ name: t.name, tokens: tok(t.chars) })) },
    messages: messages.map((m) => ({ ...m, tokens: tok(m.chars) })),
    counts: { skills: itemsOf("Skills listing"), agentTypes: itemsOf("Agent types listing"), deferredTools: itemsOf("Deferred tool names") },
    byKind: Object.fromEntries(Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, tok(v)])),
    claudeMdFiles,
    biggestSections: sections.sort((a, b) => b.chars - a.chars).slice(0, 8).map((x) => ({ label: x.label, kind: x.kind, tokens: tok(x.chars) }))
  };
}

/** Which MCP servers' tools were actually called across the given sessions (so unused ones can be flagged). */
/** @param {string[]} files @returns {Record<string, number>} */
export function usedMcpServers(files) {
  /** @type {Record<string, number>} */
  const used = {};
  for (const f of files) {
    try {
      for (const o of readJsonl(f)) for (const b of Array.isArray(o.message?.content) ? o.message.content : []) if (b.type === "tool_use" && b.name?.startsWith("mcp__")) {
        const server = b.name.split("__")[1];
        used[server] = (used[server] || 0) + 1;
      }
    } catch {}
  }
  return used;
}

/** Rule-based recommendations, each tied to a number in the report (thresholds from Anthropic's cost guidance: CLAUDE.md under ~200 lines, disable unused MCP servers). */
/** @param {any} report @param {Record<string, number>} [used] */
export function recommend(report, used = {}) {
  if (!report.available) return [];
  const out = [];
  for (const g of report.tools.groups) {
    if (g.server === "Claude Code built-in") continue;
    const calls = used[g.server] || 0;
    if (g.tokens >= 1500 && calls === 0) out.push({ tokens: g.tokens, text: `MCP server "${g.server}" adds ${g.count} tools (~${g.tokens} tokens) to every conversation and was not called in the sessions checked. Disable it if you do not use it.` });
  }
  for (const f of report.claudeMdFiles) if (f.lines > 200 || f.tokens > 2500) out.push({ tokens: f.tokens, text: `${f.file} is ~${f.tokens} tokens (${f.lines} lines). Keep CLAUDE.md under about 200 lines and move workflow-specific instructions into skills, which load only when used.` });
  const mcpInstr = report.byKind["MCP server instructions"] || 0;
  if (mcpInstr > 3000) out.push({ tokens: mcpInstr, text: `MCP server instructions add ~${mcpInstr} tokens to every conversation. Disabling servers you do not use removes them.` });
  const skills = report.byKind["Skills listing"] || 0;
  if (skills > 3000) out.push({ tokens: skills, text: `The skills listing is ~${skills} tokens (${report.counts.skills} skills) on every conversation. Remove skills and plugins you do not use.` });
  const agents = report.byKind["Agent types listing"] || 0;
  if (agents > 3000) out.push({ tokens: agents, text: `The agent-types listing is ~${agents} tokens (${report.counts.agentTypes} agent types) on every conversation. Plugins that ship many agents add to it; disable the ones you do not use.` });
  return out.sort((a, b) => b.tokens - a.tokens);
}
