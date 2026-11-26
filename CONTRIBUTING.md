# Contributing to sparelimit

We welcome contributions to make AI coding agents more token-efficient, transparent, and resilient against doom loops.

## Core Design Principles
1. **Zero External Dependencies:** The core CLI and server must run on native Node.js (20 or newer; CI runs 20, 22 and 24) without requiring `npm install` for third-party libraries.
2. **Passive Local-First:** Never intercept network requests, introduce proxy latency, or send telemetry to external cloud servers.
3. **Deterministic Math Over AI Guessing:** Use simple heuristics (context size, file churn, error codes) to detect loops instead of calling expensive LLMs to monitor other LLMs.

## Development Setup
```bash
git clone https://github.com/rotemalt/sparelimit.git
cd sparelimit
npm test            # node's built-in test runner, no dependencies
./sparelimit.mjs          # the terminal view of your latest session
```

## Where things are
`sparelimit.mjs` parses arguments and dispatches; the commands are in `src/cli/` (`session.mjs`, `plan.mjs`, `analysis.mjs`, one handler per command in each). The rest is in `src/`: `adapters/` (one per agent: Claude Code, Codex, Antigravity), `transcripts.mjs` (finding logs and the views over all of them), `report.mjs` (one session's report and its actions), `replay.mjs` and the files built on it (`habits`, `digest`, `ledger`, `why`, `sessiontimeline`), `hook.mjs` and `policy.mjs` (the guard), `server.mjs` (dashboard), `mcp.mjs`, and `method.mjs` (the methodology, generated from the same constants the code uses). Anything imported from `sparelimit.mjs` keeps working.

## Prices
Prices come from the LiteLLM list, bundled as `data/pricing.snapshot.json` with dated corrections in `data/pricing.overrides.json`. To refresh: `npm run update-pricing`. `sparelimit doctor` warns when the snapshot is over 45 days old and when a model you used in the last 14 days is past, or within 60 days of, its deprecation date.

## Release checklist
1. `npm test` passes, and CI is green on macOS and Linux.
2. Refresh prices (`npm run update-pricing`) and spot-check the models you use against the providers' own pricing pages (input, output, cache read, cache write 5m and 1h, any long-prompt tier). Note the date in the pull request or the commit message.
3. `node scripts/build-methodology.mjs` (a test fails if `site/methodology.html` is out of date).
4. Re-run `sparelimit replay --all` and check every number in the README and on the landing page against it.
5. Push `main`; the deploy workflow republishes `deploy` when `site/` changed.

## Running the MCP Server
```bash
./sparelimit.mjs mcp
```
Test with standard JSON-RPC 2.0 messages over stdin.
