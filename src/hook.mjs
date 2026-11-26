import { evaluate, DEFAULT_POLICY } from "./policy.mjs";
import { loadConfig } from "./config.mjs";
import { checkFreeze } from "./freeze.mjs";
import { callSignature } from "./schema.mjs";
import { planEstimateFromCache, scheduleRefresh } from "./plancache.mjs";
import { coldCacheAdvice, resetAdvice, readTail, COACH_DEFAULTS } from "./coach.mjs";
import { notifyDesktop } from "./notify.mjs";
import { scheduleDigest, digestLineOnce } from "./digestcache.mjs";
import { scheduleClientBudgets, clientBudgetLine, overallBudgetLine } from "./clientalert.mjs";
import { evaluatePlaybooks } from "./playbooks.mjs";
import { claudeConfigDirs } from "./accounts.mjs";
import { readJson, writeJsonAtomic, appendJsonl, snapshotPath, sessionStatePath, auditPath, overridePath, configPath, probePath } from "./state.mjs";
import fs from "node:fs";
import { trimBashOutput } from "./trim.mjs";

const SNAPSHOT_MAX_AGE_MS = 15 * 60e3;
const WARN_REPEAT_MS = 10 * 60e3;

const WINDOW_CALLS = 20;

/**
 * Handle one Claude Code hook event. Returns { stdout, stderr, exit }.
 * Fails open: any internal error allows the action and is logged, so the guard can never brick a session.
 * Documented behaviours used: PreToolUse exit 2 + stderr blocks the call; UserPromptSubmit may return
 * additionalContext (warn) or {"decision":"block","reason"} (block).
 */
export function handleHook(/** @type {any} */ event, /** @type {any} */ input, { now = Date.now(), refresh = true, notifyFn = notifyDesktop } = {}) {
  try {
    return run(event, input, now, refresh, notifyFn);
  } catch (err) {
    try {
      appendJsonl(auditPath(), { t: new Date(now).toISOString(), kind: "hook-error", event, error: String((err instanceof Error ? err.message : err) || err) });
    } catch {}
    return { stdout: "", stderr: "", exit: 0 };
  }
}

function run(/** @type {any} */ event, /** @type {any} */ input, /** @type {number} */ now, /** @type {any} */ refresh, /** @type {any} */ notifyFn) {
  const sessionId = input.session_id;
  if (event === "posttoolusefailure" || event === "posttooluse") return postTool(event, input, now);
  let snapshot = readJson(snapshotPath(sessionId));
  if (snapshot && now - (snapshot.receivedAtMs || 0) > SNAPSHOT_MAX_AGE_MS) snapshot = { ...snapshot, rateLimits: {}, stale: true };
  snapshot ||= {};

  // No exact plan numbers from the status line (e.g. the Desktop app): fall back to the estimate from the logs, kept fresh in the background.
  if (!snapshot.rateLimits?.fiveHour && !snapshot.rateLimits?.sevenDay) {
    const est = planEstimateFromCache({ now });
    if (refresh) scheduleRefresh({ now });
    if (est && est.cacheAgeMs < 15 * 60e3) {
      const win = (/** @type {any} */ w) => (w ? { pct: w.pct, resetsAt: w.resetsAt } : null);
      snapshot = { ...snapshot, quotaEstimated: true, rateLimits: { fiveHour: win(est.fiveHour), sevenDay: win(est.weekly) }, burn: { ...(snapshot.burn || {}), fiveHourPctPerHour: est.fiveHour?.ratePctPerHour ?? null } };
    }
  }

  const state = readJson(sessionStatePath(sessionId), { lastSig: null, count: 0, warned: {} });
  let loop;
  if (event === "pretooluse") {
    const sig = callSignature(input.tool_name, input.tool_input);
    state.count = sig === state.lastSig ? state.count + 1 : 1;
    state.lastSig = sig;
    state.recent = [...(state.recent || []), sig].slice(-WINDOW_CALLS);
    loop = { count: state.count, tool: input.tool_name, windowCount: state.recent.filter((/** @type {any} */ x) => x === sig).length, failCount: state.failed?.[sig] || 0 };
  }

  const ov = readJson(overridePath(), {});
  const overrideUntil = Math.max(ov.all || 0, ov.sessions?.[sessionId] || 0);
  if (event === "pretooluse" && overrideUntil <= now) {
    const fz = checkFreeze({ cwd: typeof input.cwd === "string" ? input.cwd : process.cwd(), toolName: input.tool_name, toolInput: input.tool_input, now });
    if (fz) {
      appendJsonl(auditPath(), { t: new Date(now).toISOString(), kind: "finding", rule: "scope.frozen", level: "block", message: fz.message, sessionId });
      return { stdout: "", stderr: fz.message, exit: 2 };
    }
  }
  const settings = loadConfig({ cwd: typeof input.cwd === "string" ? input.cwd : process.cwd() });
  const result = evaluate({ snapshot, loop, policy: settings.policy, now, overrideUntil });
  if (settings.ignore.rules.length) {
    result.findings = result.findings.filter((f) => !settings.ignore.rules.includes(f.rule));
    result.level = result.findings.some((f) => f.level === "block") ? "block" : result.findings.length ? "warn" : "allow";
  }

  // What to SHOW is tracked per hook event: a tool-call hook can never display a warning, so it must not use up the user-prompt hook's turn.
  state.shown ||= {};
  state.shown[event] ||= {};
  const showFresh = result.findings.filter((f) => {
    const prev = state.shown[event][f.rule];
    return !prev || prev.level !== f.level || now - prev.t > WARN_REPEAT_MS;
  });
  if (event === "userpromptsubmit") for (const f of showFresh) state.shown[event][f.rule] = { level: f.level, t: now };

  // Audit trail (feeds the Savings Ledger): log a finding when it first appears or escalates, not on every call.
  const fresh = result.findings.filter((f) => {
    const prev = state.warned[f.rule];
    return !prev || prev.level !== f.level || now - prev.t > WARN_REPEAT_MS;
  });
  for (const f of fresh) {
    appendJsonl(auditPath(), { t: new Date(now).toISOString(), kind: "finding", event, sessionId, rule: f.rule, level: f.level, message: f.message, evidence: f.evidence, overridden: result.overridden });
    state.warned[f.rule] = { level: f.level, t: now };
  }
  writeJsonAtomic(sessionStatePath(sessionId), state);

  const blocks = result.findings.filter((f) => f.level === "block");
  const text = (/** @type {any} */ list) => list.map((/** @type {any} */ f) => f.message).join(" ");
  const how = " (Override for 30 min: `sparelimit allow 30`.)";

  if (event === "pretooluse") {
    if (blocks.length) return { stdout: "", stderr: `sparelimit blocked this tool call: ${text(blocks)}${how}`, exit: 2 };
    return { stdout: "", stderr: "", exit: 0 };
  }
  if (event === "userpromptsubmit") {
    if (blocks.length) return { stdout: JSON.stringify({ decision: "block", reason: `sparelimit: ${text(blocks)}${how}` }), stderr: "", exit: 0 };
    const warn = showFresh.filter((f) => f.level === "warn");

    // Coach: a cold prompt cache on a big conversation. Shown to the user via systemMessage (the only field the docs say reaches the user).
    const coachCfg = { ...COACH_DEFAULTS, ...(readJson(configPath(), {})?.coach || {}) };
    let coach = null;
    if (input.transcript_path && coachCfg.enabled && !(state.coached && now - state.coached < WARN_REPEAT_MS)) {
      try {
        const tail = readTail(input.transcript_path);
        coach = coldCacheAdvice({ now, tail, config: coachCfg });
        // Reset coach (K1): only when the cache is warm and the status-line rule has not already said "context is full". Said once per level
        // (60%, then 80%), again after an hour if still large, and re-armed once the conversation shrinks (reset or compaction).
        if (!coach && !warn.some((f) => f.rule === "context.window")) {
          const adv = resetAdvice({ now, tail, config: coachCfg });
          const seen = state.resetCoach;
          if (!adv) {
            if (seen) {
              delete state.resetCoach;
              writeJsonAtomic(sessionStatePath(sessionId), state); // a silent prompt saves nothing else: persist the re-arm
            }
          } else if (!seen || adv.level > seen.level || now - seen.t > 60 * 60e3) {
            coach = adv;
            state.resetCoach = { level: adv.level, t: now };
          }
        }
      } catch {}
    }
    if (coach) {
      state.coached = now;
      appendJsonl(auditPath(), { t: new Date(now).toISOString(), kind: "coach", event, sessionId, rule: coach.rule, message: coach.message, evidence: coach.evidence });
      writeJsonAtomic(sessionStatePath(sessionId), state);
    }
    // Delivery test: `sparelimit probe` arms it; the next prompt shows one line through every channel, so we learn which ones reach the user.
    let probe = null;
    try {
      probe = readJson(probePath(), null);
      if (probe) fs.unlinkSync(probePath());
    } catch {}
    // Weekly digest: build it in the background when it is a week old, show a one-line summary once per digest (switch off: { "digest": { "enabled": false } }).
    let digestLine = null;
    if (readJson(configPath(), {})?.digest?.enabled !== false) {
      try {
        if (refresh) scheduleDigest({ now });
        digestLine = digestLineOnce({ now });
      } catch {}
    }
    // Client budgets: the client this folder belongs to, from totals refreshed in the background; said once per level and period per session.
    let budgetLine = null;
    if (Object.keys(settings.clients.budgets || {}).length || Object.keys(settings.budgets || {}).length) {
      try {
        if (refresh) scheduleClientBudgets({ now });
        state.clientBudgetShown ||= {};
        const mine = clientBudgetLine({ cwd: typeof input.cwd === "string" ? input.cwd : process.cwd(), rules: settings.clients.rules, shown: state.clientBudgetShown, now });
        const wide = overallBudgetLine({ shown: state.clientBudgetShown, now });
        budgetLine = [wide, mine].filter(Boolean).join(" ") || null;
      } catch {}
    }
    // Playbooks (X2): the user's own rules. Off unless enabled; a dry run is logged and shown to nobody. Said once per rule per 10 minutes.
    const playbookLines = [];
    if (settings.playbooks.enabled && settings.playbooks.rules.length) {
      try {
        state.playbookShown ||= {};
        const multiAccount = settings.playbooks.rules.some((r) => r.do.includes("other-account")) && claudeConfigDirs({ extra: settings.accounts.dirs }).length > 1;
        for (const hit of evaluatePlaybooks({ snapshot, config: settings.playbooks, now, multiAccount })) {
          const prev = state.playbookShown[hit.id];
          if (prev && now - prev < WARN_REPEAT_MS) continue;
          state.playbookShown[hit.id] = now;
          appendJsonl(auditPath(), { t: new Date(now).toISOString(), kind: "playbook", event, sessionId, rule: `playbook.${hit.id}`, when: hit.when, message: hit.message, dryRun: settings.playbooks.dryRun });
          if (!settings.playbooks.dryRun) playbookLines.push(hit.message);
        }
      } catch {}
    }
    const userLines = [...(probe ? [`(probe ${probe.id}) If you can read this line, hook messages reach you.`] : []), ...warn.map((f) => f.message), ...(coach ? [coach.message] : []), ...(digestLine ? [digestLine] : []), ...(budgetLine ? [budgetLine] : []), ...playbookLines];
    if (userLines.length) {
      // Confirmed in the Desktop app (probe, 2026-11-05): the in-app systemMessage line reaches the user. The model relay and the desktop
      // notification are opt-in; a probe always exercises all three.
      const delivery = { systemMessage: true, relay: false, desktop: false, ...(readJson(configPath(), {})?.delivery || {}) };
      if (probe) Object.assign(delivery, { systemMessage: true, relay: true, desktop: true });
      const text = `[sparelimit] ${userLines.join(" ")}`;
      const out = {};
      if (delivery.systemMessage) out.systemMessage = text;
      // The model is asked to pass the message on in one short sentence, so it appears in the chat even if the app hides hook messages.
      const toModel = [...(probe ? [`(probe ${probe.id}) The hook channel to the model works. Say "sparelimit probe ${probe.id} received" in your reply.`] : []), ...warn.map((f) => f.message), ...(coach && coachCfg.deliver === "both" ? [coach.message] : [])];
      if (toModel.length && delivery.relay) out.hookSpecificOutput = { hookEventName: "UserPromptSubmit", additionalContext: `[sparelimit] Mention this to the user in one short sentence at the start of your reply: ${toModel.join(" ")}` };
      if (delivery.desktop) notifyFn("Sparelimit", userLines.join(" "));
      if (probe) appendJsonl(auditPath(), { t: new Date(now).toISOString(), kind: "probe", sessionId, id: probe.id, channels: Object.keys(out).concat(delivery.desktop ? ["desktop"] : []) });
      writeJsonAtomic(sessionStatePath(sessionId), state);
      return { stdout: JSON.stringify(out), stderr: "", exit: 0 };
    }
  }
  return { stdout: "", stderr: "", exit: 0 };
}

/**
 * The post-tool hooks (opt-in: `sparelimit init --post-hooks`).
 *   PostToolUseFailure: counts failures per identical call (name + input) in the session state; from `loop.failWarn` of them, and when the
 *     message relay is on (`delivery.relay`), tells the agent in `additionalContext` to change something before running it again. The
 *     PreToolUse rule `loop.failing_repeat` uses the same count (a block only if `loop.failBlock` is set).
 *   PostToolUse: a success clears that call's failure count; and, if `trim.enabled`, a long Bash output is replaced by its head and tail
 *     through `updatedToolOutput` (the documented way for a hook to change what the agent reads). Fails open like every hook.
 * @param {string} event @param {any} input @param {number} now
 */
function postTool(event, input, now) {
  const sessionId = input.session_id;
  const sig = callSignature(input.tool_name, input.tool_input);
  const state = readJson(sessionStatePath(sessionId), { lastSig: null, count: 0, warned: {} });
  state.failed ||= {};
  const settings = loadConfig({ cwd: typeof input.cwd === "string" ? input.cwd : process.cwd() });
  if (event === "posttoolusefailure") {
    if (input.is_interrupt === true) return { stdout: "", stderr: "", exit: 0 }; // an abort is not the same call failing
    state.failed[sig] = (state.failed[sig] || 0) + 1;
    const keys = Object.keys(state.failed);
    if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete state.failed[k];
    writeJsonAtomic(sessionStatePath(sessionId), state);
    const n = state.failed[sig];
    const warnAt = settings.policy.loop?.failWarn ?? DEFAULT_POLICY.loop.failWarn;
    // said when the count reaches the warn level, then every fifth failure after it (not on every one: the agent may be told, and the log written, once per loop)
    if (warnAt == null || n < warnAt || (n - warnAt) % 5 !== 0) return { stdout: "", stderr: "", exit: 0 };
    const message = `${input.tool_name} has failed ${n} times with identical input. Read the error and change something before running it again, or ask the user for help.`;
    appendJsonl(auditPath(), { t: new Date(now).toISOString(), kind: "finding", event, sessionId, rule: "loop.failing_repeat", level: "warn", message, evidence: { tool: input.tool_name, failCount: n } });
    const delivery = { relay: false, ...(readJson(configPath(), {})?.delivery || {}) };
    if (!delivery.relay) return { stdout: "", stderr: "", exit: 0 };
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: `[sparelimit] ${message}` } }), stderr: "", exit: 0 };
  }
  // PostToolUse: the call worked
  if (state.failed[sig]) {
    delete state.failed[sig];
    writeJsonAtomic(sessionStatePath(sessionId), state);
  }
  const trimmed = settings.trim.enabled ? trimBashOutput(input, settings.trim) : null;
  if (!trimmed) return { stdout: "", stderr: "", exit: 0 };
  appendJsonl(auditPath(), { t: new Date(now).toISOString(), kind: "trim", event, sessionId, tool: input.tool_name, charsBefore: trimmed.charsBefore, charsAfter: trimmed.charsAfter, dryRun: settings.trim.dryRun });
  if (settings.trim.dryRun) return { stdout: "", stderr: "", exit: 0 };
  return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedToolOutput: trimmed.output } }), stderr: "", exit: 0 };
}
