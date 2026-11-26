import { windowOutlook, FIVE_HOURS, SEVEN_DAYS } from "./rates.mjs";

/**
 * Playbooks (X2): rules you write that say "when this is true, tell me this and suggest that". They sit beside the policy engine and never
 * block anything: a playbook only adds a message (and a suggestion) to the prompt hook, once per rule per 10 minutes. Off unless
 * `playbooks.enabled` is true. With `playbooks.dryRun` true they are evaluated and written to the audit log (kind "playbook", dryRun true)
 * but shown to nobody, so you can see what a rule would have said before you let it speak.
 *
 *   { "playbooks": { "enabled": true, "dryRun": false, "rules": [
 *       { "id": "five-hour-short", "when": "five-hour-runs-out", "atPct": 50, "do": ["warn", "handoff", "other-account"] },
 *       { "id": "big-context", "when": "context-pct", "atPct": 70, "do": ["warn", "handoff"] } ] } }
 *
 * `when`: five-hour-runs-out / seven-day-runs-out (the forecast says the window is used up before it resets; `atPct` optionally also needs
 * that much used), five-hour-pct / seven-day-pct / context-pct (that percentage reached), session-cost (that many dollars, API-equivalent).
 * `do`: warn (the message), handoff (`sparelimit reset`), cheaper-model (only when the session runs on Opus or Fable), other-account (only when
 * there is more than one config folder; points to `sparelimit plan --accounts`, it does not compute headroom in the hook).
 */
export const PLAYBOOK_WHEN = ["five-hour-runs-out", "seven-day-runs-out", "five-hour-pct", "seven-day-pct", "context-pct", "session-cost"];
export const PLAYBOOK_DO = ["warn", "handoff", "cheaper-model", "other-account"];
const NEEDS_PCT = new Set(["five-hour-pct", "seven-day-pct", "context-pct"]);
const MAX_RULES = 20;

/**
 * @typedef {{ id: string, when: string, atPct?: number, atUSD?: number, do: string[] }} PlaybookRule
 * @typedef {{ enabled: boolean, dryRun: boolean, rules: PlaybookRule[] }} Playbooks
 * @typedef {{ id: string, when: string, detail: string, message: string, suggestions: string[] }} PlaybookHit
 */

/** Checked settings; anything wrong in a rule drops that rule, never the others. Off by default. @returns {Playbooks} */
export function sanitizePlaybooks(/** @type {any} */ raw) {
  const out = { enabled: false, dryRun: false, rules: /** @type {PlaybookRule[]} */ ([]) };
  if (!raw || typeof raw !== "object") return out;
  out.enabled = raw.enabled === true;
  out.dryRun = raw.dryRun === true;
  const seen = new Set();
  for (const r of Array.isArray(raw.rules) ? raw.rules : []) {
    if (out.rules.length >= MAX_RULES) break;
    if (!r || typeof r !== "object" || typeof r.id !== "string" || !/^[a-z0-9._-]{1,40}$/.test(r.id) || seen.has(r.id)) continue;
    if (!PLAYBOOK_WHEN.includes(r.when)) continue;
    const doList = (Array.isArray(r.do) ? r.do : []).filter((/** @type {any} */ a) => PLAYBOOK_DO.includes(a));
    if (!doList.length) continue;
    /** @type {PlaybookRule} */
    const rule = { id: r.id, when: r.when, do: [...new Set(doList)] };
    const pctOk = typeof r.atPct === "number" && r.atPct > 0 && r.atPct <= 100;
    if (NEEDS_PCT.has(r.when) && !pctOk) continue;
    if (pctOk) rule.atPct = r.atPct;
    if (r.when === "session-cost") {
      if (!(typeof r.atUSD === "number" && r.atUSD > 0)) continue;
      rule.atUSD = r.atUSD;
    }
    seen.add(r.id);
    out.rules.push(rule);
  }
  return out;
}

/** @param {any} w a quota window of the snapshot @param {number | null | undefined} rate @param {number} windowMs @param {number} now */
const outlook = (w, rate, windowMs, now) => (w?.pct != null ? windowOutlook(w, { ratePctPerHour: rate ?? null, windowMs, now }) : null);

/**
 * What the rules say about a session right now. Pure.
 * @param {{ snapshot: any, config: Playbooks, now?: number, multiAccount?: boolean }} p
 * @returns {PlaybookHit[]}
 */
export function evaluatePlaybooks({ snapshot, config, now = Date.now(), multiAccount = false }) {
  if (!config.enabled) return [];
  const rl = snapshot?.rateLimits || {};
  const model = String(snapshot?.model || "");
  /** @type {PlaybookHit[]} */
  const hits = [];
  for (const rule of config.rules) {
    /** @type {string | null} */
    let detail = null;
    if (rule.when === "five-hour-runs-out" || rule.when === "seven-day-runs-out") {
      const five = rule.when === "five-hour-runs-out";
      const o = five ? outlook(rl.fiveHour, snapshot?.burn?.fiveHourPctPerHour, FIVE_HOURS, now) : outlook(rl.sevenDay, snapshot?.burn?.sevenDayPctPerHour, SEVEN_DAYS, now);
      if (o && o.lastsUntilReset === false && o.minutesToLimit != null && (rule.atPct == null || o.pct >= rule.atPct)) {
        detail = `the ${five ? "5-hour" : "weekly"} quota is ${Math.round(o.pct)}% used and, at ${o.ratePctPerHour}%/h, runs out in ~${o.minutesToLimit} min, before it resets in ${o.resetsInMin} min`;
      }
    } else if (rule.when === "five-hour-pct" || rule.when === "seven-day-pct") {
      const w = rule.when === "five-hour-pct" ? rl.fiveHour : rl.sevenDay;
      if (w?.pct != null && w.pct >= (rule.atPct ?? 101)) detail = `the ${rule.when === "five-hour-pct" ? "5-hour" : "weekly"} quota is ${Math.round(w.pct)}% used (rule: ${rule.atPct}%)`;
    } else if (rule.when === "context-pct") {
      if (snapshot?.contextPct != null && snapshot.contextPct >= (rule.atPct ?? 101)) detail = `the context window is ${Math.round(snapshot.contextPct)}% full (rule: ${rule.atPct}%)`;
    } else if (rule.when === "session-cost") {
      if (snapshot?.costUsd != null && snapshot.costUsd >= (rule.atUSD ?? Infinity)) detail = `this session has cost $${snapshot.costUsd.toFixed(2)} (rule: $${rule.atUSD})`;
    }
    if (!detail) continue;
    /** @type {string[]} */
    const suggestions = [];
    if (rule.do.includes("handoff")) suggestions.push("hand off to a fresh session with `sparelimit reset`");
    if (rule.do.includes("cheaper-model") && /opus|fable/i.test(model)) suggestions.push("run routine work on Sonnet (`/model sonnet`)");
    if (rule.do.includes("other-account") && multiAccount) suggestions.push("check whether another account has headroom: `sparelimit plan --accounts`");
    const warn = rule.do.includes("warn") ? `Playbook "${rule.id}": ${detail}.` : `Playbook "${rule.id}" matched.`;
    hits.push({ id: rule.id, when: rule.when, detail, message: suggestions.length ? `${warn} Suggested: ${suggestions.join("; ")}.` : warn, suggestions });
  }
  return hits;
}
