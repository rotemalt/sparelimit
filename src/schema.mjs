/**
 * Normalized session model shared by every agent adapter.
 *
 * Session = {
 *   agent, sessionId, transcriptPath,
 *   events:   Event[]        // one per unique API response (de-duplicated)
 *   userTurns: { text, createdAt }[]
 *   commandResults: { command, ok, summary }[]
 *   fileTouches: { file, kind: "read"|"write" }[]
 *   raw: { lines, usageLines, uniqueResponses }
 * }
 * Event = { id, ts, model, isSidechain, usage: Usage, context, tools: string[], confidence }
 * Usage = { input, cacheRead, cacheWrite5m, cacheWrite1h, output }   // tokens
 */

/** @typedef {{ input: number, cacheRead: number, cacheWrite5m: number, cacheWrite1h: number, output: number }} Usage tokens by class */
/** @typedef {{ id?: string, name: string, sig: string, res?: string, resChars?: number, file?: string, partial?: boolean }} Call one tool call; `file` is the path it names (Read, Edit, Write), `partial` is true for a Read by range; `res` is a short hash of what came back ("!" first when it failed) */
/** @typedef {{ id: string, ts: string, model: string | null, isSidechain: boolean, trigger?: string, usage: Usage, context: number, tools: string[], calls?: Call[], confidence: string, agentId?: string, agentType?: string | null, agentToolUseId?: string | null }} AgentEvent one API response */
/** @typedef {{ agent: string, sessionId: string, transcriptPath: string, events: AgentEvent[], userTurns: { text: string, createdAt?: string }[], commandResults: { command: string, ok: boolean, summary: string }[], fileTouches: any[], raw: any, projectDir?: string | null, subagent?: boolean, threadId?: string | null, parentId?: string | null }} Session */
/** @typedef {{ ev: AgentEvent, i: number, key: string, rates: any, cost: number, conf: string, unpriced: boolean }} PricedEvent an event with its price */

/** How much a number can be trusted. Shown next to every figure. */
export const CONFIDENCE = Object.freeze({
  EXACT: "exact", // reported by the agent itself (status-line collector, API usage object)
  DERIVED: "derived", // computed from a de-duplicated transcript
  ESTIMATED: "estimated" // an assumption was needed (unknown model, guessed split, what-if pricing)
});

const ORDER = [CONFIDENCE.ESTIMATED, CONFIDENCE.DERIVED, CONFIDENCE.EXACT];

/** Weakest confidence wins. */
export function minConfidence(/** @type {any} */ list) {
  let worst = CONFIDENCE.EXACT;
  for (const c of list) if (ORDER.indexOf(c) < ORDER.indexOf(worst)) worst = c;
  return worst;
}

import crypto from "node:crypto";

/** @type {(v: any) => string} */
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));

/** Short, stable fingerprint of a tool call (name + deep-sorted input), used to spot repeated calls. */
export function callSignature(/** @type {string} */ name, /** @type {any} */ input) {
  return `${name}:${crypto.createHash("sha1").update(stable(input ?? {})).digest("hex").slice(0, 12)}`;
}

export const emptyUsage = () => ({ input: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 });

export function addUsage(/** @type {any} */ a, /** @type {any} */ b) {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite5m: a.cacheWrite5m + b.cacheWrite5m,
    cacheWrite1h: a.cacheWrite1h + b.cacheWrite1h,
    output: a.output + b.output
  };
}

export const totalTokens = (/** @type {any} */ u) => u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h + u.output;
export const contextTokens = (/** @type {any} */ u) => u.input + u.cacheRead + u.cacheWrite5m + u.cacheWrite1h;
