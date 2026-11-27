# ⚡ Sparelimit (`sparelimit`)

> **Don't waste your AI coding limit.** Sparelimit reads the session logs your coding agent already writes, shows where the spend went, tells you when to start fresh, and counts a saving only when an alert fired, you acted, and a lower cost was measured afterwards.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Zero Dependencies](https://img.shields.io/badge/Dependencies-0-brightgreen.svg)](#)

Runs on your machine. No account, no API key, and nothing is sent unless you switch it on: [the optional count](#the-optional-count) is off until you say yes. Nothing to pay: there are no paid features. Claude Code logs are read fully, including the sessions Claude Desktop runs in agent mode (Cowork). Codex CLI sessions are read for cost and plan limits (`sparelimit codex`) and Gemini CLI sessions for cost (`sparelimit gemini`); the coaching views are Claude-only. Antigravity is partly supported. Cursor chats are read for tokens only, with no dollars (`sparelimit cursor`).

## Try it in two minutes

```bash
npm install -g https://github.com/rotemalt/sparelimit/releases/download/v1.1.0/sparelimit-1.1.0.tgz
sparelimit replay --all   # where your limit went: reads the logs you already have, nothing to set up
```

That is the release file, and the main way to install. It needs Node 20 or newer, which brings `npm`, and nothing else. If you want the source instead, see [Install](#install).

On Windows, or if you would rather not install anything, run it from the folder with `node sparelimit.mjs replay --all`. It reads `.claude/projects` in your home folder, and if you have not used Claude Code yet it says so and what to do next.

## The optional count

Off unless you say yes. After your first `sparelimit replay` or `sparelimit week` in a terminal (or when `sparelimit ledger` first shows a counted saving), Sparelimit asks once: yes, not now, or never. "Not now" is asked once more after 30 days. "Never" is never asked again. Piped output, `--json`, `--share`, CI and hooks are never asked.

If you say yes, Sparelimit downloads one tiny file from GitHub, once when you opt in and at most once a day when it counts a saving, so the author can see from GitHub's own download counter that people use it. Nothing about you or your work is sent to the author: no name, no path, no project, no time of work, and no identifier exists. GitHub sees your address, as it does for any download. The totals are public and approximate: anyone can read them, they arrive late, they can be lower than the number of downloads, and they are not a number of people. Sparelimit works the same either way.

```bash
sparelimit count status   # on or off, and what has been requested
sparelimit count show     # the two addresses that would be requested; requests nothing
sparelimit count on
sparelimit count off
```

## Start here

Five commands cover most of it. The first two need no setup: they read the logs you already have.

```bash
sparelimit replay --all    # where your limit went, across every past Claude Code session
sparelimit card            # the same as a picture and a page you can share (no prompts or paths)
sparelimit coach           # the three habits that cost you the most, ranked
sparelimit init --apply    # warn me while I work, before I am cut off
sparelimit plan            # how much of the 5-hour and weekly limit is used, and a forecast
```

`sparelimit week` is the weekly summary. `sparelimit help` prints this list; `sparelimit help all` lists every command. [Install](#install) is three lines.

On a subscription the thing you run out of is the plan limit, not money. Sparelimit prices everything in dollars at list price because that is the one unit that compares models and token classes; read the dollars as size and share of your limit, and `sparelimit plan` for the limit itself.

## How sure is each number?

Every figure Sparelimit prints carries one of three labels. When a figure is built from several, the weakest label wins. The full rules are in [`sparelimit method`](#how-every-number-is-computed) and on the methodology page.

| Label | Means |
| :--- | :--- |
| **exact** | Reported by the agent itself, not reconstructed. *Nothing on the author's machine is labelled exact today:* Claude Code's documentation says the terminal status line reports context and plan-limit percentages, but we have not yet confirmed it on a real terminal session. |
| **derived** | Computed from your logs with no assumption beyond the arithmetic. |
| **estimated** | Needs an assumption, a model of different behaviour, or a rough conversion. |

Dollars are **API-equivalent at list price**: what the same tokens would cost at public API prices, not what your plan billed. On a subscription they show size and share, not an invoice.

## What Sparelimit does not claim

- **A saving shown is not proof of cause.** A counted saving means an alert fired, you acted, and the cost measured afterwards was lower. It does not show that the alert is why you acted, or that the fall in cost is because of the alert. The two stretches of work compared may not be alike. The ledger says so itself: whether the alert was the reason is not known.
- **The rules and thresholds are the author's choices.** The author wrote the ledger's rules and chose its numbers (for example 70% of the earlier spend, and 30 minutes). They were not derived from a study or from other people's data. They are public and versioned in docs/RULES.md, so you can read them and re-run them on your own data; a change to any of them is a new version, never an edit of an old one.
- **The plan-limit method assumes the earlier pace would have continued.** It compares the 30 minutes after an alert with the 30 before and credits the difference, which assumes you would have kept spending at the earlier pace. On the author's machine, as of 2026-11-26, all three counted savings (USD 19.56 at list price) come from this method, so the headline figure rests on the weakest assumption in the ledger.
- **On a subscription a saving is limit kept, not cash.** Dollars are API-equivalent at list price. They show how much of your limit was used, not what you were billed. Only someone billed by usage keeps cash.
- **Every published number is one machine, one person, the first weeks of use.** The figures on the product page and the card are the author's own. They are not a forecast for you and not from other people. Most alerts were ignored, which is why the counted saving is small.
- **Modelled savings are models.** The "could save" figures in replay, the coach and the card (for example about 11% if every long session had been reset at 60%) assume you would have acted and that the restart would have been clean. They are labelled estimated, and they are not in the ledger.

## Send your weekly summary

If you have run Sparelimit for a week, run `sparelimit week --share` and paste the output into [a new issue](https://github.com/rotemalt/sparelimit/issues/new?template=weekly_summary.md). It leaves out times, session ids and paths, but read it once before you post: the issue is public. A complaint has [its own form](https://github.com/rotemalt/sparelimit/issues/new?template=complaint.md), and so does a [question](https://github.com/rotemalt/sparelimit/issues/new?template=question.md). Nothing is sent from your machine unless you post it.

## Follow along

There is no mailing list and the site has no forms. To hear about a new version: [watch releases on GitHub](https://github.com/rotemalt/sparelimit/releases) (Watch, Custom, Releases), or join the [discussions](https://github.com/rotemalt/sparelimit/discussions).

## Compared with other tools

A dated comparison with CodeBurn, ccusage and Claude Code's own `/usage`, read from their public pages, is in [docs/COMPARISON.md](docs/COMPARISON.md). It says where they do more than Sparelimit.

## What it found on one machine

These are the author's own numbers: 250 Claude Code sessions (including Claude Desktop agent-mode sessions), read on 2026-11-26. **Yours will differ.** Each comes from a command you can run on your own logs.

| Finding | Number | Label | Command |
| :--- | :--- | :--- | :--- |
| Total spend, all sessions | $5,941.99 | derived | `sparelimit replay --all` |
| Spend that was re-sending the conversation on every message | 58% ($3,447.54) | derived | `sparelimit replay --all` |
| Of that, the fixed starting context (system prompt, tools, memory) | 10% of all spend ($599.35) | derived | `sparelimit replay --all` |
| Coming back to a big conversation after the cache had gone cold | 221 times, $758.88 more than a warm cache | derived | `sparelimit replay --all` |
| Saving if every long session had been reset at 60% of the window | about 11% of spend (range $495.96 to $753.74) | **estimated** | `sparelimit replay --all` |

The 11% is a model, not a result: it assumes you would have reset at 60%, that the handoff is clean, and that about 25k tokens are read again afterwards. `sparelimit rebuild` measures that last assumption on real shrinks, and it is not yet supported as re-reads (see the methodology page).

**How the totals were checked, once, on an earlier and smaller set (not repeated for the run above).** On 2026-11-05, before Desktop sessions were read, Sparelimit's total and ccusage 20.0.48's differed by 0.004% on the same 93 sessions ($4,601.06 against $4,600.87). On 2026-11-06, session by session against CodeBurn 0.9.27 on 116 sessions, the main threads differed by 0.03% ($4,391.16 against $4,389.85) and subagent spend by $0.03 ($530.30 against $530.27). Both are one machine, one account type (Pro) and one agent. CodeBurn books subagent spend under separate sessions, so the comparison adds them back.

## Install

Node 20 or newer (the test suite passes on 20, 22 and 26 here, and CI runs 20, 22 and 24; Node 18 is untested), no packages to install.

From the release file (the main way):

```bash
npm install -g https://github.com/rotemalt/sparelimit/releases/download/v1.1.0/sparelimit-1.1.0.tgz
```

From the source:

```bash
git clone https://github.com/rotemalt/sparelimit.git
cd sparelimit
./install.sh        # puts `sparelimit` on your PATH (or: npm link)
```

Then, to let Sparelimit warn you while you work (a status line that records context and plan limits, and hooks that show a message), run once:

```bash
sparelimit init --apply
sparelimit doctor         # checks what is installed
```

Two extra hooks are opt-in, because each costs one more process per tool call: `sparelimit init --apply --post-hooks` adds `PostToolUse` and `PostToolUseFailure`. With them, Sparelimit counts how often the *same* call fails (from the third time it logs it, and with `delivery.relay` on it tells the agent to change something; set `policy.loop.failBlock` to make a Nth failure stop the call), and, if you switch it on with `"trim": { "enabled": true }` in the config, replaces a very long Bash output (over 20,000 characters by default) with its head and tail before the agent reads it. `"trim": { "enabled": true, "dryRun": true }` only logs what it would have cut. This follows Claude Code's hook documentation; it has not been run in a live session yet.

In the Claude Desktop app the hooks run but the status line did not when we tested, so plan usage there is estimated from your logs (see `sparelimit calibrate`) and checked against the percentages the app keeps in its own data folder (`sparelimit plan --app`). Sessions the Desktop app runs in agent mode (Cowork) are read from the app's own folder and counted (layout checked on macOS only).

## Which agents it reads

| Agent | Where it reads | What you get | What you do not |
| :--- | :--- | :--- | :--- |
| **Claude Code** (terminal, IDE, and the Desktop app's agent mode) | `~/.claude/projects`, other `CLAUDE_CONFIG_DIR` folders, the Desktop app's own folder | Everything: spend, why a session cost what it did, the guard hooks, coaching (reset timing, cold-cache returns, model mix), plan-limit estimate, ledger, history | Plan percentages in the Desktop app are estimated from your logs (its status line did not run when tested) |
| **Codex CLI** | `~/.codex/sessions` (plain JSONL; the compressed archive is not read) | Spend by model and day, subagents, the plan limits Codex last reported, client reports and budgets | The coaching views: their rules (cache lifetime, model families) are Claude's |
| **Gemini CLI** | `~/.gemini/tmp/*/chats/session-*.json` and `.jsonl` | Spend by model and day, largest sessions, client reports and budgets | Coaching; plan limits. Thinking tokens are priced as output, which is an assumption, and a preview model missing from the price list is priced at the default and marked estimated |
| **Antigravity** | `~/.gemini/antigravity/brain/*/.system_generated/logs/transcript.jsonl`, found by the live view and the HUD (`sparelimit`), or a path you pass in | Spend and the HUD where the log carries token fields; the model is read from the log's settings-change note | Many sessions carry no token fields, so coverage is partial; the coaching and history views read Claude Code logs only |

**macOS menu bar (optional):** `scripts/menubar/build.sh` compiles a small Swift companion that shows the session's cost and context in the menu bar, coloured by Sparelimit's status level, with the alert text in its menu. It runs `sparelimit status --json` every 30 seconds and sends nothing anywhere. It needs the Swift toolchain (Xcode or the Command Line Tools); its menu was checked through its `--print` mode and by launching it, not by looking at the menu bar.

Cursor is read for tokens only (`sparelimit cursor`, from its local `state.vscdb`): no dollars, because Cursor bills by request and almost no message names its model, and it is not in the coaching views, client reports or budgets. Other agents (OpenCode, Cline, Aider, Copilot) are not read yet; the plan lists what is known about their logs.

## Every command

You do not need these to start. Open a group when you want it.

<details>
<summary><b>See where it went</b></summary>


| Command | What it does |
| :--- | :--- |
| `sparelimit` | Terminal view of the latest session: cost, context size, cache share, spend rate, plan limits, what to do now. |
| `sparelimit replay [--all]` | Runs the policy over past sessions and breaks down the bill. |
| `sparelimit why [id]` | Ranks the causes that cost one session the most, each with dollars, share and label. |
| `sparelimit timeline [id]` | How one session's context grew, with numbered moments: window levels, shrinks (with cost per response before and after), cold returns, loops, error floods, swarms, and what Sparelimit said. |
| `sparelimit card [--hide-dollars] [--share] [--out=dir]` | A shareable report card: an image (SVG, 1200 x 630) and a self-contained page with your spend split and the three changes that matter most. Totals, shares and labels only: no prompts, project names or paths. |
| `sparelimit clients budget "Acme" monthly=400` / `sparelimit clients --check` | Budgets per client (daily, weekly, monthly), Claude Code, Codex and Gemini CLI together; `--check` exits 1 when a client is over. `sparelimit report --client "Acme" --with-budget` shows the budget in the client report. |
| `sparelimit report --client "Acme"` | A client-ready page (print it to PDF): spend by week, by project and by agent (Claude Code, Codex and Gemini CLI) for one client from your rules. No prompts, paths or scripts; `--hide-projects` leaves project names out. |
| `sparelimit clients` | Spend by client, from rules you write (`sparelimit clients add /path "Acme"` or `--contains=acme`): total, 30 days, 7 days, and the largest projects no rule covers yet. Matching is on the project's logged folder name. |
| `sparelimit sync --dir <folder>` | One view across your devices. Writes one small file of totals (UTC day, account, model, token classes, list-price dollars; never prompts, paths, project names or code) into a folder your devices already share (iCloud Drive, Dropbox, Syncthing, a private git repository) and reads the other devices' files. Sparelimit sends nothing itself. A file that is damaged or from a newer version is skipped with a message. Tested with simulated devices only, not yet on two real machines. |
| `sparelimit accounts` | Spend by Claude account on this machine, from your config folders (`CLAUDE_CONFIG_DIR`, `~/.claude-*`): sessions, total, last 7 days. Name an account with `sparelimit accounts label`. No email is read. Checked on one account only. |
| `sparelimit codex` | What your Codex CLI sessions cost: tokens (exact as logged), dollars at list price (derived), by model and by day, and the plan limits Codex last reported. Coaching rules are not applied (they are Claude's). |
| `sparelimit gemini [--json]` | What your Gemini CLI sessions cost (read from `~/.gemini/tmp`): spend by model and day, tokens, the largest sessions. A model missing from the price list is priced at the default and marked estimated. The coaching views are not applied. |
| `sparelimit cursor [--json]` | What your Cursor chats used, read from Cursor's local `state.vscdb` through the system `sqlite3` program (read-only): tokens by session, day and model, the largest sessions. **Tokens only, no dollars:** Cursor bills by request and almost no message names its model. `CURSOR_DB` points at the file if it is elsewhere. |
| `sparelimit quota-fit [--json]` | Tries to fit how many points of the five-hour limit a million tokens of each class use, from the Desktop app's own percentages and your logs, with out-of-sample error next to the dollar model. Refuses to fit with fewer than 20 readings (today there are 4) and says so. |
| `sparelimit serve` | Local dashboard at `http://localhost:4321`: plan gauges, spend, the feed of alerts with the ledger's verdict, the timeline. |

</details>

<details>
<summary><b>Know what to change</b></summary>

| Command | What it does |
| :--- | :--- |
| `sparelimit coach` | The habits that cost you the most, ranked by dollars at list price, each labelled exact, derived or estimated. |
| `sparelimit digest` | A weekly summary with one focus for next week. |
| `sparelimit setup` | The fixed starting context, itemised, and what to trim. |
| `sparelimit models` | Which kinds of work could run on a cheaper model, with your own failure rates beside it (not like for like). |
| `sparelimit delegate` | Subagent cost, and when a swarm is not worth it. |

</details>

<details>
<summary><b>Stay inside the limit</b></summary>

| Command | What it does |
| :--- | :--- |
| `sparelimit plan --accounts` | The planner for several Claude accounts: each account's 5-hour and weekly usage from its own folder and its own calibration, which has the most headroom now, and a warning before switching into one near its limit. `--account=<name>` on `plan` and `calibrate` picks one. |
| `sparelimit plan` | Your 5-hour and weekly usage and a forecast, estimated from your logs. |
| `sparelimit calibrate --five=60 --weekly=85 --weekly-reset="fri 14:00"` | Type in what the app shows; Sparelimit fits your limit to it. More points make it better. |
| `sparelimit plan --app` / `sparelimit calibrate --from-app` | Reads the plan percentages the Claude Desktop app itself recorded (sparse, not live), checks Sparelimit's estimate against them, and can use them as calibration points. |
| `sparelimit safe-to-share <file>` | Before you post a picture or a page made from Sparelimit's output: scans the text file it was made from for home paths, email addresses, session ids, exact times (they show when you work), credential shapes, and the names of your own user, computer and project folders. Lists what it found, changes nothing, sends nothing. It cannot read a PNG or JPG: check the output it came from. `sparelimit week` (as text), `sparelimit coach` and `sparelimit card` print none of these; `sparelimit week --json`, `sparelimit ledger` and `sparelimit why` print exact times, and `sparelimit ledger --json` and `sparelimit why` print session ids or a project name. `--share` on `week`, `ledger` and `card` gives days instead of times, no session ids, and runs this check on its own output. The rule for a screenshot is in [docs/SCREENSHOTS.md](docs/SCREENSHOTS.md). |
| `sparelimit act` | The one word for acting on an alert: the same as `sparelimit reset` (writes `.sparelimit-handoff.md` and copies a short handoff prompt), so that acting costs a few keystrokes. Then `/clear` and paste. Most alerts are ignored, and the ledger only counts a saving when you act. |
| `sparelimit reset` | Writes `.sparelimit-handoff.md` and copies a short handoff prompt. |
| `sparelimit allow [minutes]` | Turns hard stops into warnings for a while. |
| `sparelimit playbooks [example]` | Your own rules ("if the forecast says the 5-hour window runs out before it resets, warn me and suggest a handoff"). Off by default; `dryRun` logs what a rule would say and shows it to nobody. `example` prints a starting file. |
| `sparelimit policy [agency-day\|weekly-pace\|steady\|off]` | Shows the thresholds in force and sets a preset (starting points, not measured). Per-project settings go in `.sparelimit/config.json`. |
| `sparelimit budget daily=50 weekly=200 monthly=700 [--check]` | Spend today, this week and this month against your limits; `--check` exits 1 when over, for scripts and CI. |

</details>

<details>
<summary><b>Check the proof</b></summary>

| Command | What it does |
| :--- | :--- |
| `sparelimit week [--days=N] [--json] [--share]` | The weekly summary: for the last 7 days (or N, or `--days=0` for everything), the alerts that fired, how many you acted on, the counted saving, and what was not counted and why. Counts are labelled derived and the saving estimated. |
| `sparelimit ledger [--json] [--share]` | Savings counted only when an alert fired, you acted, and a comparable cost was measured afterwards. Counted savings can be negative; ignored alerts are not counted. Every rule and threshold is public and versioned in [docs/RULES.md](docs/RULES.md); the output prints the rules version, and a change to any rule is a new version in [docs/CHANGELOG.md](docs/CHANGELOG.md), never an edit of an old one. |
| `sparelimit efficacy [--days=N] [--json]` | For each warning, nudge or playbook message: what the session's spend did in the 15 minutes after, against the 15 before (slowed, held, rose, went quiet). Shows what followed, not what the message caused. |
| `sparelimit files [--json]` | The files that cost the most to read across your sessions (what carrying each read in the conversation cost), and the big ones read whole, again and again. |
| `sparelimit drains [--json]` | Spend on turns you did not type, by what started them: finished background tasks, Stop hooks and `/goal`, continuations. Where the unprompted spend came from, not a verdict that it was wasted. |
| `sparelimit value --plan=<$/month> [--days=N] [--allowance=<$>] [--rate=<x>] [--json]` | What you used at list price against what your plan costs, and a labelled scenario of what a base-plus-pay-per-cost price would charge for the same usage. A scenario from the numbers you pass, not a quote. |
| `sparelimit history [--days=N] [--json]` | Spend by week and by project over the last N days (default 30), and the causes that cost the most across your sessions (each on its own: they overlap and are never added up). |
| `sparelimit adopt <habit>` / `sparelimit track` | Tell Sparelimit the day you started a habit; it compares the time before and after. |
| `sparelimit rebuild` | Measures what comes back in the 10 responses after real shrinks (X15). |
| `sparelimit method [section]` | How every number is computed. Generated from the same constants the code uses, so it cannot drift. |

</details>

Also: `sparelimit watch` (live, with desktop alerts), `sparelimit mcp` (an MCP server so your agent can read its own telemetry), `sparelimit status --json`, `sparelimit muzzle`, `sparelimit freeze` (locks the files the work is about; the hook then refuses edits to other files, for 8 hours or until `sparelimit freeze --off` or `sparelimit allow`), `sparelimit rule --install` (guardrail text for `CLAUDE.md` and `.cursorrules`).

## Privacy

- Everything runs locally. The dashboard listens on the loopback address only and checks the Host and Origin of every request.
- **Prompt text is left out by default** of the live API, the web files, `.sparelimit-status.json` and `sparelimit status --json`: your requests keep only their length, failed commands keep only the command name, your home folder shows as `~`. The text appears only when you ask for it (`sparelimit reset`, the reset or copy button). `SPARELIMIT_SHOW_PROMPTS=1` turns the redaction off.
- Before a handoff, a status file or an export carries your text, Sparelimit hides the shapes of well-known credentials (private keys; Anthropic, OpenAI-style, Stripe, GitHub, AWS, Google, Slack and npm keys; JSON web tokens; bearer tokens; passwords in URLs; `api_key=...` assignments). A secret with no known shape, such as a plain password in a sentence, is **not** found.
- Sparelimit keeps a cache of each session's results in `~/.sparelimit/replay-cache` so the views over all sessions take a fraction of a second after the first run. It holds numbers, session ids, project folder paths, tool names and rule messages, **no prompt text**. It is recomputed whenever the log, the code or the prices change. `SPARELIMIT_NO_CACHE=1` turns it off; deleting the folder is always safe.
- Not redacted: the answers the MCP server gives to your own agent.

The full statement is in [docs/PRIVACY.md](docs/PRIVACY.md), and the [terms of use](docs/TERMS.md) say what you can expect from the software.

## How every number is computed

`sparelimit method` prints it; [`site/methodology.html`](site/methodology.html) is the same text as a page. Both are generated from `src/method.mjs`, and a test fails if the page differs from the code. They also say what Sparelimit cannot know: whether a cheaper model gave a worse result, your real bill, use of the same plan from other surfaces, and why you stepped away.

To check Sparelimit against another tool on your own logs:

```bash
sparelimit replay --all --json      # summary.totalCostUSD is the total over every Claude Code session
npx ccusage@latest            # compare its total over the same period (flags differ by version)
```

Prices come from the community-maintained [LiteLLM price list](https://github.com/BerriAI/litellm), bundled as `data/pricing.snapshot.json` (refresh with `npm run update-pricing`), with dated corrections in `data/pricing.overrides.json`. You can override any price in `~/.sparelimit/pricing.json`. A model Sparelimit does not know is priced at a default and labelled estimated.

## Develop

```bash
npm test       # node's built-in test runner, no dependencies
```

Contributing notes are in [CONTRIBUTING.md](CONTRIBUTING.md); security reports go through [SECURITY.md](SECURITY.md).

## License

MIT.

Third-party parts and their licences: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Not affiliated

Sparelimit is an independent project. It is not affiliated with, endorsed by or sponsored by Anthropic, OpenAI, Google, Anysphere (Cursor) or the makers of any other tool it names. Claude, Claude Code, Codex, Gemini, Cursor and other names are trademarks of their owners, and are used only to say what Sparelimit reads or is compared with.
