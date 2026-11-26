import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./helpers.mjs";

const hasSwift = process.platform === "darwin" && spawnSync("swiftc", ["--version"], { stdio: "ignore" }).status === 0;

test("the macOS menu-bar companion compiles and, in --print mode, shows what `sparelimit status --json` says, or a readable line when it cannot", { skip: !hasSwift && "needs macOS and the Swift toolchain", timeout: 180000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-menubar-"));
  const bin = path.join(dir, "SparelimitMenubar");
  const build = spawnSync("swiftc", ["-O", "-o", bin, path.join(ROOT, "scripts", "menubar", "SparelimitMenubar.swift"), "-framework", "AppKit"], { encoding: "utf8" });
  assert.equal(build.status, 0, build.stderr);

  // a home with one small Claude Code session, so `sparelimit status --json` has something to read
  const home = path.join(dir, "home");
  const proj = path.join(home, ".claude", "projects", "-p");
  fs.mkdirSync(proj, { recursive: true });
  const line = (id, ts) => JSON.stringify({ type: "assistant", sessionId: "s1", uuid: id, timestamp: ts, message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 0, output_tokens: 100 }, content: [] } });
  fs.writeFileSync(path.join(proj, "s1.jsonl"), [line("a", new Date().toISOString())].join("\n") + "\n");
  const env = { ...process.env, HOME: home, SPARELIMIT_HOME: path.join(home, ".sparelimit"), SPARELIMIT_NO_CACHE: "1" };
  const ok = spawnSync(bin, ["--node", process.execPath, "--sparelimit", path.join(ROOT, "sparelimit.mjs"), "--print"], { encoding: "utf8", env });
  const lines = ok.stdout.trim().split("\n");
  assert.match(lines[0], /^\$\d+\.\d\d · \d+k$/, "title: cost and context");
  assert.ok(["good", "warn", "critical"].includes(lines[1]), `level ${lines[1]}`);
  assert.ok(lines.some((l) => /\((derived|exact|estimated)\)/.test(l)), "the status line carries its confidence");
  assert.ok(lines.some((l) => /Next message carries about \$\d+\.\d{3} \(estimated\)/.test(l)));

  const bad = spawnSync(bin, ["--node", "/nonexistent/node", "--sparelimit", path.join(ROOT, "sparelimit.mjs"), "--print"], { encoding: "utf8", env });
  assert.deepEqual(bad.stdout.trim().split("\n").slice(0, 2), ["Sparelimit", "unknown"]);
  assert.match(bad.stdout, /Could not start node/);
});
