import { spawn, spawnSync } from "node:child_process";

/**
 * Clipboard and desktop notifications on macOS, Linux and Windows (A12). Nothing goes through a shell: text is passed on stdin or as a
 * single argument, so a message can never be run as a command. Each function returns whether it did the thing, and never throws: a hook
 * must not break because a notifier is missing. Checked on macOS only; the Linux and Windows paths use the standard tools (wl-copy, xclip,
 * xsel, notify-send, clip) and are covered by tests that stub the platform and the lookup, not by a run on those systems.
 */
const hasCommand = (/** @type {any} */ cmd, platform = process.platform) => {
  try {
    return spawnSync(platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
};

/** The command that puts stdin on the clipboard, or null when there is none. */
export function clipboardCommand({ platform = process.platform, env = process.env, has = (/** @type {any} */ c) => hasCommand(c, platform) } = {}) {
  if (platform === "darwin") return { cmd: "pbcopy", args: [] };
  if (platform === "win32") return { cmd: "clip", args: [] };
  if (env.WAYLAND_DISPLAY && has("wl-copy")) return { cmd: "wl-copy", args: [] };
  if (has("xclip")) return { cmd: "xclip", args: ["-selection", "clipboard"] };
  if (has("xsel")) return { cmd: "xsel", args: ["--clipboard", "--input"] };
  if (has("wl-copy")) return { cmd: "wl-copy", args: [] };
  return null;
}

export function copyToClipboard(/** @type {string} */ text, opts = {}) {
  const c = clipboardCommand(opts);
  if (!c) return false;
  try {
    return spawnSync(c.cmd, c.args, { input: String(text), stdio: ["pipe", "ignore", "ignore"], timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

const clip = (/** @type {any} */ s, n = 220) => String(s).slice(0, n);

/** The command for a desktop notification, or null (Windows has none here: a toast needs a script, which is not worth the risk). */
export function notifyCommand(/** @type {string} */ title, /** @type {string} */ message, { platform = process.platform, has = (/** @type {any} */ c) => hasCommand(c, platform), sound = false } = {}) {
  if (platform === "darwin") {
    const esc = (/** @type {any} */ s) => clip(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return { cmd: "osascript", args: ["-e", `display notification "${esc(message)}" with title "${esc(title)}"${sound ? ' sound name "Basso"' : ""}`] };
  }
  if (platform === "linux" && has("notify-send")) return { cmd: "notify-send", args: ["--", clip(title, 80), clip(message)] };
  return null;
}

/** Fire and forget. SPARELIMIT_NO_NOTIFY turns it off. */
export function notifyDesktop(/** @type {string} */ title, /** @type {string} */ message, opts = /** @type {any} */ ({})) {
  if ((opts.env || process.env).SPARELIMIT_NO_NOTIFY) return false;
  const c = notifyCommand(title, message, opts);
  if (!c) return false;
  try {
    spawn(c.cmd, c.args, { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}
