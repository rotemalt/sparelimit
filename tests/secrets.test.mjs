import test from "node:test";
import assert from "node:assert/strict";
import { scrubSecrets, countSecrets } from "../src/secrets.mjs";
import { analyzeTranscript } from "../sparelimit.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const fake = {
  anthropic: "sk-ant-api03-" + "a1B2c3D4e5F6g7H8i9J0",
  openai: "sk-proj-" + "Zy9x8w7v6u5t4s3r2q1p0o",
  github: "ghp_" + "A".repeat(36),
  aws: "AKIA" + "ABCDEFGHIJKLMNOP",
  slack: "xoxb-" + "1234567890-abcdefghij",
  jwt: "eyJhbGciOiJIUzI1" + ".eyJzdWIiOiIxMjM0NTY3" + ".SflKxwRJSMeKKF2QT4",
  stripe: "sk_live_" + "a1b2c3d4e5f6g7h8i9j0"
};

test("known secret shapes are hidden, each by its own name", () => {
  for (const [k, v] of Object.entries(fake)) {
    const out = scrubSecrets(`use ${v} for this`);
    assert.ok(!out.includes(v), `${k} was not hidden`);
    assert.match(out, /\[hidden/);
  }
  assert.equal(scrubSecrets("-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----"), "[hidden private key]");
});

test("assignments, bearer tokens and passwords in URLs keep their name and lose the value", () => {
  assert.equal(scrubSecrets("export API_KEY=abcdef123456 && run"), "export API_KEY=[hidden] && run");
  assert.equal(scrubSecrets('{"password": "hunter2hunter2"}'), '{"password": "[hidden]"}');
  assert.equal(scrubSecrets("curl -H 'Authorization: Bearer abcdefghijklmnop1234'"), "curl -H 'Authorization: Bearer [hidden]'");
  assert.equal(scrubSecrets("postgres://admin:s3cretpw@db.example.com/app"), "postgres://admin:[hidden]@db.example.com/app");
});

test("ordinary text, code and short values are left alone; non-strings pass through; the text only gets shorter or equal", () => {
  for (const t of ["Fix the login bug in auth.js", "const token = getToken();", "password: x", "see https://example.com/a/b?c=d", "sk-short", ""]) assert.equal(scrubSecrets(t), t);
  assert.equal(scrubSecrets(null), null);
  assert.equal(scrubSecrets(5), 5);
  assert.equal(countSecrets(`a ${fake.github} b ${fake.aws}`), 2);
});

test("a handoff built from a session never carries a key from the last request or a failed command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-sec-"));
  const f = path.join(dir, "s.jsonl");
  const L = [
    { type: "user", sessionId: "s", uuid: "u1", timestamp: "2026-11-06T08:00:00Z", message: { role: "user", content: `deploy with ${fake.github} please` } },
    { type: "assistant", sessionId: "s", uuid: "a1", timestamp: "2026-11-06T08:00:05Z", message: { id: "m1", model: "claude-sonnet-5-5", usage: { input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, output_tokens: 50 }, content: [] } }
  ];
  fs.writeFileSync(f, L.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const r = analyzeTranscript(f);
  assert.ok(r.userTurns.length, "the user turn was read");
  assert.ok(!r.handoffPrompt.includes(fake.github));
  assert.ok(!JSON.stringify(r).includes(fake.github));
  assert.match(r.handoffPrompt, /deploy with \[hidden GitHub token\] please/);
});
