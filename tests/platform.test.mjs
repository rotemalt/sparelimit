import test from "node:test";
import assert from "node:assert/strict";
import { clipboardCommand, notifyCommand, notifyDesktop, copyToClipboard } from "../src/platform.mjs";

const only = (...names) => (c) => names.includes(c);

test("clipboard: the standard tool for each system, Wayland before X, and null when none is installed", () => {
  assert.deepEqual(clipboardCommand({ platform: "darwin" }), { cmd: "pbcopy", args: [] });
  assert.deepEqual(clipboardCommand({ platform: "win32" }), { cmd: "clip", args: [] });
  assert.deepEqual(clipboardCommand({ platform: "linux", env: { WAYLAND_DISPLAY: "w0" }, has: only("wl-copy", "xclip") }), { cmd: "wl-copy", args: [] });
  assert.deepEqual(clipboardCommand({ platform: "linux", env: {}, has: only("wl-copy", "xclip") }), { cmd: "xclip", args: ["-selection", "clipboard"] });
  assert.deepEqual(clipboardCommand({ platform: "linux", env: {}, has: only("xsel") }), { cmd: "xsel", args: ["--clipboard", "--input"] });
  assert.deepEqual(clipboardCommand({ platform: "linux", env: {}, has: only("wl-copy") }), { cmd: "wl-copy", args: [] });
  assert.equal(clipboardCommand({ platform: "linux", env: {}, has: () => false }), null);
  assert.equal(copyToClipboard("x", { platform: "linux", env: {}, has: () => false }), false, "no tool is a false, not an error");
});

test("notifications: macOS through osascript with the text escaped, Linux through notify-send with the text as arguments, none on Windows", () => {
  const mac = notifyCommand('a "quoted" title', 'say "hi" \\ now', { platform: "darwin", sound: true });
  assert.equal(mac.cmd, "osascript");
  assert.equal(mac.args[1], 'display notification "say \\"hi\\" \\\\ now" with title "a \\"quoted\\" title" sound name "Basso"');
  const linux = notifyCommand("Sparelimit", "$(rm -rf ~); `x`", { platform: "linux", has: only("notify-send") });
  assert.deepEqual(linux, { cmd: "notify-send", args: ["--", "Sparelimit", "$(rm -rf ~); `x`"] }, "text is an argument, never a shell command");
  assert.equal(notifyCommand("a", "b", { platform: "linux", has: () => false }), null);
  assert.equal(notifyCommand("a", "b", { platform: "win32" }), null);
  assert.equal(notifyCommand("t", "m".repeat(500), { platform: "linux", has: only("notify-send") }).args[2].length, 220);
});

test("SPARELIMIT_NO_NOTIFY turns notifications off, and a missing notifier is a false, not an error", () => {
  assert.equal(notifyDesktop("a", "b", { env: { SPARELIMIT_NO_NOTIFY: "1" }, platform: "darwin" }), false);
  assert.equal(notifyDesktop("a", "b", { env: {}, platform: "linux", has: () => false }), false);
});
