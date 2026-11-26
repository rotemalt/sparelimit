/**
 * G2: known secret shapes are replaced with a placeholder before text from a session is put in a handoff, a status file or an export.
 * It matches the shape of well-known credentials, not "anything that looks random", so it will miss a secret with no known shape
 * (a bare password in prose). That limit is stated on the methodology page. The scan only ever shortens text.
 */
/** @type {[string, RegExp, string?][]} name, pattern, and a replacement (default: [hidden <name>]) */
export const SECRET_PATTERNS = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{16,}/g],
  ["OpenAI-style key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ["Stripe key", /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/g],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["password in a URL", /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi, "$1[hidden]$2"],
  ["bearer token", /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, "$1[hidden]"],
  ["secret assignment", /\b((?:[A-Za-z0-9_]*(?:api[_-]?key|secret|token|passwd|password|pwd|auth)[A-Za-z0-9_]*)["']?\s*[:=]\s*["']?)(?!\[hidden\])[^\s"',;()]{8,}(?![\w(])/gi, "$1[hidden]"]
];

/** The text with known secret shapes hidden. Non-strings pass through. */
export function scrubSecrets(/** @type {string} */ text) {
  if (typeof text !== "string" || !text) return text;
  let out = text;
  for (const [name, re, repl] of SECRET_PATTERNS) out = out.replace(re, repl || `[hidden ${name}]`);
  return out;
}

/** How many secret shapes were in the text (for tests and `sparelimit` messages), without keeping them. */
export function countSecrets(/** @type {string} */ text) {
  if (typeof text !== "string") return 0;
  return SECRET_PATTERNS.reduce((n, [, re]) => n + (text.match(re)?.length || 0), 0);
}
