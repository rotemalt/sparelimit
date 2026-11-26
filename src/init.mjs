/**
 * Compute the Claude Code settings.json changes that install the collector (status line) and the guard (hooks).
 * Pure function: never touches disk, so it is safe to unit test and to print as a dry run.
 *
 * - An existing status line is never overwritten: pass `chainExisting` to keep showing it through `sparelimit statusline --chain`.
 * - Existing hooks are preserved; ours are appended once (idempotent, recognised by the `sparelimit-managed` marker in the command).
 */
const MARK = "# sparelimit-managed";

/**
 * @param {any} [existing]
 * @param {{ sparelimitCmd?: string, chainExisting?: boolean, postHooks?: boolean }} [opts]
 */
export function buildSettingsPatch(existing = {}, { sparelimitCmd, chainExisting = false, postHooks = false } = {}) {
  const settings = JSON.parse(JSON.stringify(existing));
  const notes = [];

  const sl = existing.statusLine;
  const ours = sl?.command?.includes("statusline") && sl.command.includes(MARK);
  if (!sl || ours) {
    settings.statusLine = { type: "command", command: `${sparelimitCmd} statusline ${MARK}` };
    notes.push(ours ? "status line already managed by sparelimit (refreshed)" : "status line installed");
  } else if (chainExisting && sl.type === "command" && sl.command) {
    const quoted = `'${sl.command.replace(/'/g, `'\\''`)}'`;
    settings.statusLine = { ...sl, command: `${sparelimitCmd} statusline --chain=${quoted} ${MARK}` };
    notes.push("existing status line kept and chained");
  } else {
    notes.push("SKIPPED status line: you already have one. Re-run with --chain-existing to keep it and add the collector.");
  }

  settings.hooks ||= {};
  // The post-tool hooks (failing-repeat detection, output trimming) cost one more process per tool call, so they are opt-in.
  /** @type {string[][]} */
  const events = [["UserPromptSubmit", "userpromptsubmit"], ["PreToolUse", "pretooluse"], ...(postHooks ? [["PostToolUse", "posttooluse"], ["PostToolUseFailure", "posttoolusefailure"]] : [])];
  for (const [event, arg] of events) {
    const list = (settings.hooks[event] ||= []);
    const has = list.some((/** @type {any} */ g) => (g.hooks || []).some((/** @type {any} */ h) => h.command?.includes(MARK)));
    if (!has) {
      list.push({ matcher: "*", hooks: [{ type: "command", command: `${sparelimitCmd} hook ${arg} ${MARK}`, timeout: 5 }] });
      notes.push(`${event} hook installed`);
    } else notes.push(`${event} hook already installed`);
  }
  return { settings, notes };
}

/** Remove everything sparelimit installed. */
export function removeSparelimit(existing = {}) {
  const s = JSON.parse(JSON.stringify(existing));
  if (s.statusLine?.command?.includes(MARK)) delete s.statusLine;
  for (const ev of Object.keys(s.hooks || {})) {
    s.hooks[ev] = s.hooks[ev].filter((/** @type {any} */ g) => !(g.hooks || []).some((/** @type {any} */ h) => h.command?.includes(MARK)));
    if (!s.hooks[ev].length) delete s.hooks[ev];
  }
  if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
  return s;
}
