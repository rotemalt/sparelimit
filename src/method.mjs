import { REWORK } from "./rework.mjs";
import { DEFAULT_POLICY } from "./policy.mjs";
import { COACH_DEFAULTS } from "./coach.mjs";
import { REPLAY } from "./replay.mjs";
import { DELEGATION } from "./delegation.mjs";
import { RISK } from "./models.mjs";
import { LEDGER } from "./ledger.mjs";
import { WHY } from "./why.mjs";
import { SECRET_PATTERNS } from "./secrets.mjs";
import { REBUILD } from "./rebuild.mjs";
import { DESKTOP } from "./desktopplan.mjs";
import { PRESETS } from "./policy.mjs";
import { FREEZE } from "./freeze.mjs";
import { MIN_RESPONSES, MIN_RELATIVE_CHANGE, HABITS } from "./adoption.mjs";
import { MIN_CALIBRATION_PCT } from "./planestimate.mjs";
import { TIMELINE } from "./sessiontimeline.mjs";

/**
 * The methodology, as data. `sparelimit method` prints it and scripts/build-methodology.mjs renders site/methodology.html from it; a test
 * fails if the committed page differs from what this module produces. Every threshold below is read from the code that applies it,
 * so the page cannot say one thing while the tool does another. Facts measured on the author's own data are plain text and dated.
 *
 * Inline markup: `code` and **bold**. Blocks: { p }, { ul }, { table: { head, rows } }, { code }.
 */
const pct = (/** @type {any} */ x) => `${Math.round(x * 100)}%`;
const k = (/** @type {number} */ n) => `${Math.round(n / 1000)}k`;
const risk = (/** @type {any} */ r) => Object.entries(RISK).filter(([, v]) => v === r).map(([t]) => t).join(", ");
const P = DEFAULT_POLICY;

/**
 * What Sparelimit does not claim. One list, three readers: the methodology page, `sparelimit method`, and the README (a test checks the README carries
 * each sentence). Plain words, no softening and no boasting. Numbers come from the ledger's table, so they cannot drift from the code.
 */
export const NOT_CLAIMED = [
  { lead: "A saving shown is not proof of cause.", text: "A counted saving means an alert fired, you acted, and the cost measured afterwards was lower. It does not show that the alert is why you acted, or that the fall in cost is because of the alert. The two stretches of work compared may not be alike. The ledger says so itself: whether the alert was the reason is not known." },
  { lead: "The rules and thresholds are the author's choices.", text: "The author wrote the ledger's rules and chose its numbers (for example " + Math.round(LEDGER.rateSlowdown * 100) + "% of the earlier spend, and " + LEDGER.rateMinutes + " minutes). They were not derived from a study or from other people's data. They are public and versioned in docs/RULES.md, so you can read them and re-run them on your own data; a change to any of them is a new version, never an edit of an old one." },
  { lead: "The plan-limit method assumes the earlier pace would have continued.", text: "It compares the " + LEDGER.rateMinutes + " minutes after an alert with the " + LEDGER.rateMinutes + " before and credits the difference, which assumes you would have kept spending at the earlier pace. On the author's machine, as of 2026-11-26, all three counted savings (USD 19.56 at list price) come from this method, so the headline figure rests on the weakest assumption in the ledger." },
  { lead: "On a subscription a saving is limit kept, not cash.", text: "Dollars are API-equivalent at list price. They show how much of your limit was used, not what you were billed. Only someone billed by usage keeps cash." },
  { lead: "Every published number is one machine, one person, the first weeks of use.", text: "The figures on the product page and the card are the author's own. They are not a forecast for you and not from other people. Most alerts were ignored, which is why the counted saving is small." },
  { lead: "Modelled savings are models.", text: "The \"could save\" figures in replay, the coach and the card (for example about 11% if every long session had been reset at 60%) assume you would have acted and that the restart would have been clean. They are labelled estimated, and they are not in the ledger." }
];

export const METHOD_DATE = "2026-11-05";

export const METHOD = {
  title: "How Sparelimit's numbers are computed",
  lead: "Every figure Sparelimit prints says how sure it is, and this page says how each one is worked out. It is generated from the same code that does the arithmetic, so the thresholds below cannot differ from the ones the tool uses. Where something is a guess, it is called a guess.",
  sections: [
    {
      id: "read-first",
      title: "Read this first",
      blocks: [
        { ul: [
          "**Dollars are API-equivalent at list price.** They are what the same tokens would cost at the public API prices, not what your plan billed you. On a subscription they show size and share, not an invoice.",
          "**The tool runs on your machine.** Sparelimit reads the session logs your coding agent already writes and sends nothing unless you switch it on (the optional count, `sparelimit count`). Currently only Claude Code logs are read fully; Antigravity is partly supported.",
          "**Estimates overlap.** The savings listed for different habits are different views of the same spend. Adding them up counts some money twice, so Sparelimit never does."
        ] }
      ]
    },
    {
      id: "labels",
      title: "The three labels",
      blocks: [
        { p: "Each number carries one of three labels. When a figure is built from several, the weakest label wins." },
        { table: { head: ["Label", "Means", "Example"], rows: [
          ["exact", "Reported by the agent itself, not reconstructed.", "Context size and plan-limit percentages from Claude Code's status line, which its documentation says the terminal version provides. We have not yet confirmed that ourselves on a real terminal session: treat it as documented, not verified."],
          ["derived", "Computed from your logs with no assumption beyond the arithmetic.", "What a session cost, how much of it was re-reading the conversation, how many subagents ran."],
          ["estimated", "Needs an assumption, a model of different behaviour, or a rough conversion.", "What a fresh start would have saved; plan usage from logs; what a cheaper model would have cost."]
        ] } }
      ]
    },
    {
      id: "sources",
      title: "Where the numbers come from",
      blocks: [
        { p: "**One response, counted once.** Claude Code writes one log line per content block (thinking, text, each tool call) and repeats the same token usage on every one. Adding the lines overcounts: on one real session, 105 assistant lines were 36 real responses, which overstated cache reads 2.95 times and output 3.03 times. Sparelimit keys each response by its message id and counts it once." },
        { p: "**Subagents are billed too.** They log to a `subagents` folder beside the session. Sparelimit reads those files as side threads, so their spend is not missing, and identifies each one (its file name, its type, and the call that started it). A first version that read only the main file was 11% low against ccusage; the comparison found it and it was fixed." },
        { p: "**Each response is priced by its own model.** Prices come from the LiteLLM price table, bundled as a trimmed snapshot and shown with an \"as of\" date. Sparelimit prices input, output, cache reads and cache writes (5-minute and 1-hour separately), the higher rate above a model's long-prompt threshold where one exists, and prices that change on a date. You can override any price in `~/.sparelimit/pricing.json`. On " + METHOD_DATE + " the snapshot was checked against the providers' own pricing pages for Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5, Opus 4.7 and Sonnet 4.5." },
        { p: "**A model Sparelimit does not know is priced at a default and labelled estimated**, never silently." }
      ]
    },
    {
      id: "crosscheck",
      title: "Cross-checks, corrections, and how to reproduce them",
      blocks: [
        { ul: [
          "**ccusage.** On " + METHOD_DATE + ", over the same 93 Claude Code sessions, Sparelimit's total was $4,601.06 and ccusage 20.0.48 reported $4,600.87: 0.004% apart, every session within 5%. This is the author's machine only.",
          "**CodeBurn was not reconciled.** It reports a different total and appears to book subagent spend under separate sessions. We could not tell which attribution is right and do not claim either.",
          "**A retracted figure.** An early estimate that \"$85 of avoidable context\" could be saved was wrong: it counted only the stretch after the 95% stop, where Claude Code auto-compacts anyway, so it measured the wrong alternative. It was withdrawn and replaced by the reset model below.",
          "**A corrected headline.** One Antigravity session first showed $37 because it was priced as the wrong model. Priced as the model it actually used, it was about $12. The point that survived: 96% of its tokens were cache re-reads."
        ] },
        { p: "To check Sparelimit against another tool on your own logs:" },
        { code: "sparelimit replay --all --json     # summary.totalCostUSD is the total over every Claude Code session\nnpx ccusage@latest           # compare its total over the same period (flags differ by version)" }
      ]
    },
    {
      id: "plan",
      title: "Plan usage (the 5-hour and weekly bars)",
      blocks: [
        { p: "Claude Code's documentation says its status line reports these percentages in the terminal version, which would make them exact; we have not yet confirmed that on a real terminal session. In the Claude Desktop app the status line did not run when we tested, so Sparelimit estimates the percentages from your logs." },
        { ul: [
          "**Windows.** A 5-hour window opens at the first activity after the previous one ended, rounded down to the hour. This reproduced a real 11:00 to 16:00 window exactly. The weekly window is anchored to the reset time you give.",
          "**Calibration.** You type what the app shows (`sparelimit calibrate`). Sparelimit divides the spend your logs show in that window by the percentage, and takes the median over your calibration points of " + MIN_CALIBRATION_PCT + "% or more. The result is a limit in API-equivalent dollars.",
          "**Check.** One out-of-sample prediction, made before the app's numbers were known and from a limit fitted on a single earlier point, gave 96% and 89%; the app showed 97% and 90%. That is one check, on one account type (Pro).",
          "**The app's own record.** The Claude Desktop app keeps the five-hour and weekly percentages it showed in a file in its data folder (`sparelimit plan --app` reads it, read-only, and drops the organisation id). Those are the app's own figures, but sparse (a sample is written when the app fetches usage, so there are gaps of days) and in an undocumented format that is ignored if it changes. `sparelimit plan --app` checks Sparelimit's estimate against them, each sample estimated from a limit fitted on the others; `sparelimit calibrate --from-app` uses the samples between " + MIN_CALIBRATION_PCT + "% and " + DESKTOP.usableMax + "% as calibration points. 0 and 100 are clamps and are not used. The weekly figure is not imported: its resets in that file do not fall on a fixed 7 days.",
          "**Label: estimated.** Other surfaces that draw on the same plan (claude.ai chat, other tools) are not in the logs, so the real figure may be higher. By default an estimate warns but never blocks."
        ] }
      ]
    },
    {
      id: "spend",
      title: "Where the spend goes, and what could be saved",
      blocks: [
        { p: "`sparelimit replay` runs the policy over past sessions and breaks down the bill. These are **derived** from the logs: re-sending the conversation on every message, adding new content, what the model writes, and the fixed starting context (the smallest context seen in the session, re-read on every message)." },
        { p: "The levers below are **estimated**. They overlap, and none of them is a promise." },
        { table: { head: ["Lever", "How it is worked out", "Assumptions that matter"], rows: [
          ["Start fresh at " + pct(REPLAY.resetThreshold) + " of the window", "Per session, the cost of re-reading the conversation as it really grew, against the cost if it had been reset at " + pct(REPLAY.resetThreshold) + ": the rebuilt context is written once and the model writes a summary of " + REPLAY.summaryOutTokens.toLocaleString("en-US") + " tokens. Growth per response comes from the log; after a reset the context is the median level seen after real auto-compactions (" + pct(REPLAY.defaultPostCompactionFraction) + " of the window if there was none).", "Files re-read after a reset: " + k(REPLAY.rebuildTokens) + " tokens, shown as a range from " + k(REPLAY.rebuildHighSaving) + " to " + k(REPLAY.rebuildLowSaving) + ". A drop of " + pct(1 - REPLAY.compactionDrop) + " or more in one step counts as a real compaction. Only sessions of " + REPLAY.minMessagesToModel + "+ messages are modelled."],
          ["Do not resume after a break", "A response whose context is " + k(REPLAY.coldMinContext) + "+ tokens, after a gap longer than the cache lifetime (5 minutes, or 1 hour if the log shows 1-hour caching), with under " + pct(REPLAY.coldMissedShare) + " of it read from cache. Cost = the whole context at the cache-write price. A fresh start = the starting context + " + k(REPLAY.handoffTokens) + " handoff + " + k(REPLAY.rebuildTokens) + " re-read, at the same price.", "Counted only if resuming cost at least $" + REPLAY.coldMinExtraUSD.toFixed(2) + " more than a warm cache. The resume cost is derived; the fresh-start cost is estimated."],
          ["Hand verbose output to a subagent", "Tool results of " + DELEGATION.verboseTokens.toLocaleString("en-US") + "+ tokens kept in the conversation, priced as written once and re-read until the next compaction, less a " + DELEGATION.answerTokens.toLocaleString("en-US") + "-token answer in their place, less one subagent's median measured cost per session.", "Sizes are measured in characters at about " + REPLAY.charsPerToken + " per token. Never negative: when it does not pay, it says 0."],
          ["Cheaper model for low-risk work", "Each response on Opus or Fable is priced again on the next tier down (Opus on Sonnet 5.5, Fable on Opus 5.5) with the same tokens.", "Quality is not measured (see below). A plan limit may weigh models differently from list prices."]
        ] } }
      ]
    },
    {
      id: "live",
      title: "What Sparelimit says while you work",
      blocks: [
        { p: "These come from hooks that run on your own prompts. A hook never builds a report; it reads a small cache and answers in milliseconds." },
        { ul: [
          "**Context warning at " + P.context.warnPct + "%, stop at " + P.context.blockPct + "%** of the window. This needs the context figure from the status line; where that does not run (the Desktop app), only the reset coach below speaks, reading the context from the transcript, and it advises without stopping anything.",
          "**Break advisor.** If the cache has gone cold on a conversation of " + k(COACH_DEFAULTS.minContextTokens) + "+ tokens and resuming would cost at least $" + COACH_DEFAULTS.breakMinUSD.toFixed(2) + " more than a warm cache, it says what resuming costs against a fresh start.",
          "**Reset coach.** From " + COACH_DEFAULTS.resetAtPct + "% of the window with a warm cache: the saving is the messages left before auto-compaction (about 95% of the window, at the median growth in the log, at most " + COACH_DEFAULTS.resetHorizonMessages + ") times (current context minus a fresh start of the starting context + " + k(COACH_DEFAULTS.handoffTokens) + " handoff + " + k(COACH_DEFAULTS.rebuildTokens) + " re-read) at the cache-read price. It stays quiet below $" + COACH_DEFAULTS.resetMinSavingUSD.toFixed(2) + ". A 1,000,000-token window is assumed only once a conversation has passed 200,000. **Estimated.**",
          "**Loops.** Live, the same tool call repeated back to back warns at " + P.loop.warnAfter + " and stops at " + P.loop.blockAfter + "; the live hook does not see the results. In a replay, which does, a \"no progress\" loop (same call and same result) uses the same numbers (" + P.loop.noProgressWarn + " and " + P.loop.noProgressBlock + "), and repeats whose results differ are not loops.",
          "**Dollar budgets** warn at $" + P.budget.sessionWarnUSD + " per session and never block by default: on 93 real sessions a lower cap fired on almost every long session."
        ] }
      ]
    },
    {
      id: "agents",
      title: "Subagents and swarms",
      blocks: [
        { p: "Per subagent, **derived** from its log: cost, the context it started with, the size of the answer it handed back (from the result of the call that started it), and how many ran at once." },
        { ul: [
          "**Swarm:** " + DELEGATION.swarmConcurrent + "+ running at once or " + DELEGATION.swarmAgents + "+ in a session, **and** subagents are at least " + pct(DELEGATION.materialShare) + " of that session's spend.",
          "**Heavy:** no swarm, but subagents are at least " + pct(DELEGATION.heavyShare) + " of the session's spend. Otherwise **ok**.",
          "The verdict describes cost and shape. Whether a swarm was worth it depends on what it produced, which a log cannot show."
        ] }
      ]
    },
    {
      id: "timeline",
      title: "The session timeline",
      blocks: [
        { p: "`sparelimit timeline` and the local dashboard draw one session: the context as a share of the window at each response, the cumulative cost below it, and numbered moments. The horizontal axis is the response number, not the clock, so a session that spans days stays readable; pauses of " + TIMELINE.awayMinutes + " minutes or more are shaded. Everything is **derived** from the log, except the one figure labelled **estimated**." },
        { ul: [
          "**Window levels.** The first response where the context reaches " + P.context.warnPct + "% of the window, and where it reaches " + P.context.blockPct + "%, in each climb. A climb ends when the context shrinks, or falls " + TIMELINE.rearmBelowPct + " points below the warning level.",
          "**Shrinks.** The context falls by " + pct(1 - REPLAY.compactionDrop) + " or more from one response to the next. The log cannot tell a /compact from an auto-compaction or a /clear, so the moment says only that it shrank. Each shrink also shows a **measured** before/after: the mean cost per response over the " + LEDGER.preResponses + " responses before it against the next " + LEDGER.postResponses + " after (cut at the next shrink; shown only with at least 5 before and " + LEDGER.minPost + " after). It is a comparison, not proof of a saving: the work after may differ from the work before.",
          "**Cold returns.** A response that processed the whole conversation again after a break longer than the cache lifetime: the same rule as the break advisor, with the gap and the extra cost.",
          "**Loops.** Where the replay's loop rules fired: the same call repeated, and the same call with the same result.",
          "**Rewrite loops and failing repeats** (`sparelimit why`, derived). A file edited " + REWORK.minEdits + " or more times with each edit within " + REWORK.gapResponses + " responses of the one before; the same command, with identical input, failing " + REWORK.minFails + " or more times in a session. The dollars are the responses that made the later repeats (a response with several calls is shared between them). They show what the repeats rode on, not a saving: some of those edits were needed, and the first edit or failure is not counted.",
          "**Error floods.** " + TIMELINE.errorFlood + " or more tool calls that the tool reported as errors within " + TIMELINE.errorWindow + " consecutive responses. One bad patch is one moment, placed on its first failure; the next needs " + TIMELINE.errorQuiet + " responses without a flood.",
          "**Swarms.** " + DELEGATION.swarmConcurrent + " or more subagents running at the same time, judged by the time span of each subagent's responses.",
          "**What Sparelimit said.** Every alert or nudge shown in that session, from the audit log; the same rule within 30 minutes is one moment."
        ] },
        { p: "The summary gives the share of responses, and of spend, at or above the warning level (derived), and the replay's estimate of starting fresh at " + pct(REPLAY.resetThreshold) + " for that session (estimated, see the levers above). The window is taken as 200,000 tokens unless the conversation passed that, then the model's maximum, as in the replay; a wrong assumption moves the percentages, not the dollars. The dashboard runs on your machine only, asks for a session by its id, and shows the project's folder name, never a full path." }
      ]
    },
    {
      id: "why",
      title: "Why a session cost what it did",
      blocks: [
        { p: "`sparelimit why` ranks the causes that cost one session the most, each with its dollars and its share of the session's spend. It is built only from the session replay, so every figure traces to `sparelimit replay`. A cause is listed only if it is at least " + WHY.minSharePct + "% of the session's spend." },
        { ul: [
          "**Avoidable** rows are a modelled change in behaviour, so they are **estimated**: starting fresh at " + pct(REPLAY.resetThreshold) + " of the window instead of letting the conversation grow (the same model as the earlier-reset figure), and the spend on responses that repeated a call the loop rules had flagged (**derived**).",
          "**At stake** rows are spend in an area, an upper bound on what could be saved there and not a saving: coming back after the cache expired (the extra over a warm cache, **derived**), the fixed starting context (**derived**), subagents (their total cost, **derived**), files read again with an identical result and large tool outputs kept in the conversation (what they cost to carry, **estimated**, because sizes are measured in characters).",
          "**The causes overlap.** A large context makes re-reads and cold returns dearer too. So they are never added up and no total is shown."
        ] }
      ]
    },
    {
      id: "rebuild",
      title: "The reset assumption, measured",
      blocks: [
        { p: "The earlier-reset estimate assumes " + Math.round(REPLAY.rebuildTokens / 1000) + "k tokens are re-read after a reset (files read again). `sparelimit rebuild` measures what the logs show after the shrinks that really happened (a /compact, an auto-compaction or a /clear inside one session, with at least " + REBUILD.minAfter + " responses after it), over the next " + REBUILD.windowResponses + " responses." },
        { ul: [
          "**Files read again.** The size of Read results for files already read earlier in the session. Sizes are in characters, about " + REPLAY.charsPerToken + " per token.",
          "**Upper bounds.** The size of all tool output in those responses, and how much the context grew over them. New work is in both, so they overshoot what is rebuilt.",
          "**It is a proxy.** A compaction keeps a summary of the work; a fresh start with a short handoff keeps less, so it probably re-reads more. The assumption is not replaced until there are at least " + REBUILD.minEvents + " measured fresh-start handoffs."
        ] }
      ]
    },
    {
      id: "settings",
      title: "Settings, presets and budgets",
      blocks: [
        { p: "Settings live in `~/.sparelimit/config.json` and, per project, in `.sparelimit/config.json` in the project folder. A project folder can be something you downloaded, so its file may only make a check stricter: a lower limit or an earlier warning. It cannot switch a warning off, raise a limit, ignore a rule, change what your agent reads, change your playbooks or add folders to read. Every value is checked: a number or null where a threshold goes, a known preset name, a list of rule names to ignore. A value of the wrong type is dropped, never read as \"off\", so a typo cannot switch a guard off." },
        { ul: [
          "**Presets** (`sparelimit policy`) are starting points, not measured optima: round figures for a kind of day. `agency-day` warns at $" + PRESETS["agency-day"].budget.hourlyWarnUSD + " an hour and stops at $" + PRESETS["agency-day"].budget.hourlyBlockUSD + ". `weekly-pace` warns when the weekly quota is used " + PRESETS["weekly-pace"].quota.weeklyPaceMarginPts + " points faster than the week has gone (day 3 of 7 is 43%, so more than 50%), once a seventh of the week has passed. `steady` is both, with the context warning at " + PRESETS.steady.context.warnPct + "%. Your own values always win over a preset. Tune them against `sparelimit replay` on your own sessions.",
          "**Budgets** (`sparelimit budget`) compare spend today, this week and this month with limits you set. The periods are the local calendar: midnight, Monday midnight, the 1st. Dollars are API-equivalent at list price (**derived**), so on a subscription a budget is a pace limit, not a bill. `sparelimit budget --check` exits 1 when any budget is over, for scripts and CI.",
          "**Scope freeze** (`sparelimit freeze`) lists the files the work is about, and the hook then refuses edits to any other file (Edit, Write, MultiEdit, NotebookEdit; a shell command is not guessed at). It applies only in the project folder that holds `.sparelimit-freeze.json`, expires after " + FREEZE.ttlHours + " hours so a forgotten lock cannot strand anyone, and is lifted by `sparelimit freeze --off` or by `sparelimit allow`. A path the hook cannot read from the call is allowed: a guard must never block on a guess.",
          "**Ignored rules** (`ignore.rules`) silence a rule by name, in the hook only. Replays and reports still show it."
        ] }
      ]
    },
    {
      id: "accounts",
      title: "Accounts on this machine",
      blocks: [
        { p: "`sparelimit accounts` shows spend by Claude account. People with more than one account usually keep a config folder for each (selected with `CLAUDE_CONFIG_DIR`: `~/.claude`, `~/.claude-work`, ...), and each folder has its own `projects/` logs and its own signed-in account. So a session belongs to the account of the config folder its log is in, which needs no guessing." },
        { ul: [
          "**Folders considered:** `~/.claude`, `CLAUDE_CONFIG_DIR`, any `~/.claude-*` folder that has a `projects` folder, and folders you add with `sparelimit accounts add-dir`. Spend and sessions are **derived** from the logs (dollars at list price).",
          "**What is read of an account:** a hash of the account or organisation id, the organisation name and the plan type. The email is never read, and an organisation named after an email address is shown as \"personal\". `sparelimit accounts label <folder or id> \"Client A\"` names one; your name wins.",
          "**Agent-mode sessions** (Claude Desktop) record no account inside their logs, but the folder they are kept in is named after the signed-in account (an observation on one machine, not documented by the app). When that account is the one a config folder holds, they are counted as that account's; when it is another, they are listed as their own Desktop account; any other layout is listed apart. A folder with no account file is shown as unknown, never as the default account.",
          "**Plan usage is per account.** Each account has its own 5-hour and weekly limits, so each has its own calibration and its own spend. The current account is the one this shell uses (`CLAUDE_CONFIG_DIR` if it is set, else the default folder), which is also what a hook sees, so it lands on the right account without being told. `sparelimit calibrate --account=<name | folder | id start>` and `sparelimit plan --account=...` pick another one; `sparelimit plan --accounts` shows them all and says which has the most headroom, and warns before switching into one that is near its limit (**estimated**). A calibration point for a non-default account is tagged with its folder; the default folder's points carry no tag, as before accounts existed, so nothing recorded earlier changes. Desktop agent-mode sessions count for the account their folder names; one whose path names no account counts toward the default account only, which is an assumption.",
          "**Limits:** the use of an account from claude.ai chat or another machine is in no log. The folder discovery and the attribution were tested on built folders: the author's machine has one config folder and one account, so a second real account has not been seen."
        ] }
      ]
    },
    {
      id: "clients",
      title: "Clients (spend by project)",
      blocks: [
        { p: "`sparelimit clients` groups sessions by the client they were for, with rules you write: a project folder, or text in a folder name, mapped to a label. The first rule that matches wins, and sessions no rule matches are **Unassigned**, with their largest projects listed so the next rule is easy to write. Spend is **derived** from the logs (dollars at list price)." },
        { ul: [
          "**Matching is on the folder's logged name.** Claude Code names a project's log folder after its working directory with every character that is not a letter or digit turned into a dash, so a path rule also matches a folder whose name merely starts the same way (`/x/Acme` also matches `/x/Acme-site`); the encoded forms cannot be told apart. Text rules are not case-sensitive.",
          "**Settings** are global (`~/.sparelimit/config.json`) and per project (`.sparelimit/config.json`); a project's own rules come first. Rules are checked: a path must be absolute, text at least two characters, a name one to sixty.",
          "**The client report** (`sparelimit report --client \"Acme\" [--days=30] [--hide-projects]`) writes one self-contained page for a client: total, working sessions, spend by week (a chart), by project and by agent (Claude Code and Codex). It has no prompts, no paths, no scripts and no external resources, and everything from the logs is escaped. Print it to PDF from a browser to send it. Claude Code sessions are matched to the client by the folder name Claude Code logs, Codex sessions by the working directory they record, using the same rules. A Codex subagent's spend is the client's, but a subagent is part of a conversation, not a session of its own. Weeks start on Monday (UTC); `--hide-projects` leaves project names out as well.",
          "**Client budgets** (`sparelimit clients budget \"Acme\" daily=20 weekly=100 monthly=400`, `sparelimit clients --check`) compare each client's spend today, this week (from Monday) and this month (from the 1st), on the local calendar, with the limits you set. Claude Code and Codex spend count together; a session no rule matches belongs to no client and has no budget. `--check` exits 1 when any client is over, for scripts and CI. The client report shows the budget only if you ask (`--with-budget`): a budget is often an internal number. On a subscription a budget is a pace limit, not a bill.",
          "**What it is not:** an invoice. On a subscription the dollars show how much of the plan a client's work used, at list price, not what anyone was billed."
        ] }
      ]
    },
    {
      id: "codex",
      title: "Codex sessions",
      blocks: [
        { p: "`sparelimit codex` reads Codex CLI sessions from `~/.codex/sessions` (plain JSONL; the compressed archive is not read, to keep Sparelimit free of dependencies) and shows what they cost. The format was checked on 150 real sessions from Codex CLI 0.165." },
        { ul: [
          "**Tokens are exact** as the log reports them. One usage record is written per API response, with its own id, so a response is counted once. Where a file has no such record, the running token counts are used instead, ignoring a count that did not change. The two agree exactly in most files; in the others the per-response records are slightly larger, which is why they are preferred.",
          "**Input includes the cached part**, so the uncached input is the difference. Output includes the model's reasoning. A separate cache-write figure was zero in every event seen; if it ever appears it is treated as part of the input, which is an assumption.",
          "**Dollars are derived**: those tokens at list price, by the model of each response. A model that is not in the price list is priced at a default and counted separately as **estimated**; the command shows how much.",
          "**Plan limits** (5-hour and weekly percent used) are what Codex itself writes in its log, so they are **exact**, as of the time shown. They are not live: they are the last reading in the newest session.",
          "**Forecast** (**estimated**): where the 5-hour and weekly limits are heading. The 5-hour pace is taken from the last 30 minutes of the current window, from the running maximum of the readings: the percentages are account-wide and several sessions report their own, slightly different, snapshots, so a lower number later in time is an older snapshot, not a reset. With no recent reading, and always for the week, the window average is used, and it is not used before a fifth of the window has passed (a burst at the start of a week says nothing about the week). Once a window has reset since the last reading, nothing is forecast.",
          "**The coaching views are not applied to Codex** (when to reset, cold-cache returns, which model to use). Their rules are Claude's: its cache lifetime and its model families. Applying them to Codex would produce numbers with nothing behind them.",
          "**Subagents are grouped under the conversation that started them.** Codex writes each subagent as a session of its own that names its parent; on 155 real sessions all 134 subagents had their parent present, up to two levels deep. A conversation's cost includes its subagents (and theirs); a subagent whose parent is not in the logs counts as a conversation of its own. The command shows how many subagents ran, what they cost, and the widest fan-out (**derived**).",
          "**Limits.** Files touched are not extracted, and Codex dollars have not been checked against a bill."
        ] }
      ]
    },
    {
      id: "models",
      title: "Which model for which work",
      blocks: [
        { p: "Each response on an expensive model is put in a type by what it did, because that is what a log shows. How hard the thinking was is invisible, so the risk tiers are a **rule of thumb, not a measurement**:" },
        { table: { head: ["Risk", "Types of work"], rows: [["low", risk("low") + ": the model mostly chooses what to run or read next"], ["medium", risk("medium") + ": a wrong edit costs rework"], ["high", risk("high") + ": responses with no tool call (planning, deciding)"]] } },
        { p: "Beside the saving, Sparelimit shows how often tool calls failed on each model in your own history. That is a rough signal and not like for like: harder work may have gone to the stronger model. The way to settle it is to move one kind of work for a week and compare retries." }
      ]
    },
    {
      id: "ledger",
      title: "How a saving is counted (the ledger)",
      blocks: [
        { p: "A saving is **counted** only when all three hold: an alert fired (it is in the audit log), you acted (visible in the logs afterwards), and a comparable cost was measured on the other side. Everything else is listed but not counted." },
        { table: { head: ["Alert", "Counts when you...", "Saving"], rows: [
          ["Context reset (coach nudge or status-line warning)", "shrank the conversation by " + pct(1 - LEDGER.resetDropRatio) + " or more within 15 responses (e.g. /compact), or started a new conversation in the same project within " + LEDGER.restartWithinMin + " minutes with a start at most half as large.", "Mean cost per response in the " + LEDGER.preResponses + " before, minus the mean over the next " + LEDGER.postResponses + " after (at least " + LEDGER.minPost + "), times those responses."],
          ["Cold cache", "started a new conversation within " + LEDGER.coldRestartWithinMin + " minutes instead of resuming, with no cold-cache response in the 5 minutes after the alert.", "What resuming would have cost (tokens times price, from the alert) minus the measured cost of the new conversation's first 3 responses."],
          ["Plan limit (all sessions together)", "slowed to " + pct(LEDGER.rateSlowdown) + " or less of the previous " + LEDGER.rateMinutes + " minutes' spend, and kept working (" + LEDGER.rateMinResponses + "+ responses).", "The difference over those " + LEDGER.rateMinutes + " minutes. It assumes the earlier pace would have continued."]
        ] } },
        { ul: [
          "Repeated alerts within 30 minutes are one intervention.",
          "A plan-limit saving that overlaps a counted reset or cold-cache saving is not counted twice.",
          "**Counted savings can be negative.** If the cost went up afterwards, the ledger shows that.",
          "Work that simply stops after an alert is not credited to the alert. Ignored alerts show what they predicted, and that money was not saved.",
          "An alert is *pending* until its window is over, and *no data* if the logs cannot settle it. Loop stops and budget alerts are not in the ledger yet."
        ] }
      ]
    },
    {
      id: "adoption",
      title: "Did a habit change?",
      blocks: [
        { p: "Each habit is tracked by one behaviour that logs can show, measured as a **rate** so a busier week does not look like a worse habit." },
        { table: { head: ["Habit", "Behaviour measured", "Smallest change that counts"], rows: Object.entries(HABITS).map(([id, h]) => [id, h.unit, `${h.minAbs.toLocaleString("en-US")} ${h.metric === "startMedian" ? "tokens" : h.metric === "coldPer100" ? "per 100" : "points"}`]) } },
        { p: "The start date is the one you declare with `sparelimit adopt`, else the first time the coach nudged about the habit, else the last 14 days are compared with the 14 before. Both periods need at least " + MIN_RESPONSES + " responses, and a change must be at least " + pct(MIN_RELATIVE_CHANGE) + " relative and at least the amount above. The verdicts are improved, worse, no clear change, too early (under 7 days) and not enough data." },
        { p: "**\"Improved\" means the behaviour moved the right way, not that the habit caused it.** The work differs between periods, so cost per 100 responses is shown beside the behaviour, and it can rise while the habit improves." }
      ]
    },
    {
      id: "does-not-claim",
      title: "What Sparelimit does not claim",
      blocks: [
        { ul: NOT_CLAIMED.map((c) => "**" + c.lead + "** " + c.text) }
      ]
    },
    {
      id: "limits",
      title: "What Sparelimit cannot know",
      blocks: [
        { ul: [
          "Whether the cheaper model, the shorter conversation or the smaller swarm gave a worse result. Quality is not in a log.",
          "Your real bill or plan percentage in the Desktop app, except by estimate from your logs and your calibration.",
          "Use of the same plan from claude.ai chat or other machines.",
          "Sessions Claude Desktop runs in agent mode (Cowork). Sparelimit reads them from the app's own folder, as it reads Claude Code's, and counts them toward spend and the plan estimate. The folder layout is the app's own and was checked on macOS only. Chat in claude.ai and use on other machines are still not in any log Sparelimit can read.",
          "Every secret in your text. Before a handoff, a status file or an export carries your last request or a failed command, Sparelimit hides the shapes of well-known credentials (" + SECRET_PATTERNS.length + " kinds: private keys, Anthropic, OpenAI-style, Stripe, GitHub, AWS, Google, Slack and npm keys, JSON web tokens, bearer tokens, passwords in URLs, and name = value assignments such as api_key=...). A secret with no known shape, such as a plain password in a sentence, is not found. Prompt text is also left out of those files by default (`SPARELIMIT_SHOW_PROMPTS=1` opts in).",
          "Why you stepped away, or whether a pause was a break or a reaction to an alert. That is why work that stops is not credited to an alert.",
          "Anything on an account type or agent it has not been checked on. The price and total checks so far are one Pro account and Claude Code; Codex tokens are as its log reports them and its dollars have not been checked against a bill."
        ] }
      ]
    },
    {
      id: "reproduce",
      title: "Reproduce any of it",
      blocks: [
        { code: "sparelimit replay --all     # the spend breakdown and the levers\nsparelimit coach            # what to change, ranked\nsparelimit delegate         # subagents and swarms\nsparelimit models           # model what-ifs and your failure rates\nsparelimit plan             # estimated plan usage\nsparelimit track            # did a habit change?\nsparelimit ledger           # savings counted so far\nsparelimit method           # this page, in your terminal\n# add --json to most of them for the raw numbers" }
      ]
    }
  ]
};

// ---- rendering
const esc = (/** @type {any} */ s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const inline = (/** @type {any} */ s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\*([^*]+)\*/g, "<i>$1</i>");
const plain = (/** @type {any} */ s) => String(s).replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1");

/**
 * @param {any} [m]
 * @param {string | null} [only] one section id, or everything
 */
export function renderMethodText(m = METHOD, only = null) {
  const out = [`\n⚡ ${m.title.toUpperCase()}`, "──────────────────────────────────────────────────────────────", plain(m.lead), ""];
  for (const s of m.sections.filter((/** @type {any} */ x) => !only || x.id === only)) {
    out.push(s.title.toUpperCase());
    for (const b of s.blocks) {
      if (b.p) out.push(`  ${plain(b.p)}`);
      if (b.ul) for (const li of b.ul) out.push(`  • ${plain(li)}`);
      if (b.table) for (const r of b.table.rows) out.push(`  • ${plain(r[0])}: ${r.slice(1).map(plain).join(" | ")}`);
      if (b.code) out.push(...b.code.split("\n").map((/** @type {any} */ l) => `    ${l}`));
    }
    out.push("");
  }
  return out.join("\n");
}

export function renderMethodHtml(m = METHOD) {
  const body = m.sections.map((s) => `<section id="${s.id}"><h2>${esc(s.title)}</h2>
${s.blocks.map((/** @type {any} */ b) => {
    if (b.p) return `<p>${inline(b.p)}</p>`;
    if (b.ul) return `<ul>\n${b.ul.map((/** @type {any} */ li) => `<li>${inline(li)}</li>`).join("\n")}\n</ul>`;
    if (b.table) return `<div class="tw"><table><thead><tr>${b.table.head.map((/** @type {any} */ h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>\n${b.table.rows.map((/** @type {any} */ r) => `<tr>${r.map((/** @type {any} */ c, /** @type {any} */ i) => (i === 0 ? `<th scope="row">${inline(c)}</th>` : `<td>${inline(c)}</td>`)).join("")}</tr>`).join("\n")}\n</tbody></table></div>`;
    if (b.code) return `<pre><code>${esc(b.code)}</code></pre>`;
    return "";
  }).join("\n")}
</section>`).join("\n");
  const toc = m.sections.map((s) => `<li><a href="#${s.id}">${esc(s.title)}</a></li>`).join("\n");
  return `<!doctype html>
<html lang="en" data-theme="light"><head><script>try{document.documentElement.dataset.theme=localStorage.getItem("sparelimit-theme")==="dark"?"dark":"light"}catch(e){}</script><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Methodology: Sparelimit</title>
<meta name="description" content="How Sparelimit computes every number it shows, how a saving is counted, and what each label (exact, derived, estimated) means.">
<style>
:root,[data-theme="light"]{color-scheme:light;--paper:#f4f7ff;--ink:#0a1230;--muted:#4a5878;--blue:#1f4bff;--line:#d5dcf2;--code:#e9eeff}
[data-theme="dark"]{color-scheme:dark;--paper:#0a111c;--ink:#e8eef7;--muted:#93a3b8;--blue:#7b97ff;--line:#243247;--code:#142033}
body{margin:0;background:var(--paper);color:var(--ink);font:17px/1.7 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:36px 24px 72px}
a{color:var(--blue)} .logo{font:700 26px ui-serif,"New York",Georgia,serif;letter-spacing:-.03em;color:var(--ink);text-decoration:none}
h1{font:700 clamp(34px,6vw,54px)/1.05 ui-serif,"New York",Georgia,serif;letter-spacing:-.03em;margin:40px 0 16px}
h2{font:700 24px/1.3 ui-serif,"New York",Georgia,serif;margin:44px 0 8px;scroll-margin-top:16px}
p,li{color:var(--muted)} p{margin:0 0 12px} li{margin:0 0 8px} p b,li b,td b{color:var(--ink)}
.lead{font-size:19px;color:var(--ink)}
nav ol{columns:2;column-gap:32px;padding-left:20px;margin:16px 0 0} nav li{break-inside:avoid;margin:0 0 4px}
code{background:var(--code);border-radius:4px;padding:1px 5px;font:.88em ui-monospace,Menlo,monospace}
pre{background:var(--code);border-radius:8px;padding:14px 16px;overflow-x:auto;margin:0 0 12px} pre code{background:none;padding:0}
.tw{overflow-x:auto;margin:0 0 14px} table{border-collapse:collapse;width:100%;font-size:15px;line-height:1.55}
th,td{border-top:1px solid var(--line);padding:9px 10px 9px 0;text-align:left;vertical-align:top;color:var(--muted)} thead th{color:var(--ink);border-top:0} tbody th{color:var(--ink);font-weight:600;padding-right:14px;white-space:nowrap}
:focus-visible{outline:3px solid var(--blue);outline-offset:3px}
@media (max-width:560px){nav ol{columns:1} tbody th{white-space:normal}}
</style></head>
<body><main>
<a class="logo" href="./">sparelimit.</a>
<h1>${esc(m.title)}</h1>
<p class="lead">${inline(m.lead)}</p>
<nav aria-label="Sections"><ol>
${toc}
</ol></nav>
${body}
<p style="margin-top:44px">Last generated from the code on ${METHOD_DATE}. <a href="./">Back to the site</a> &middot; <a href="privacy.html">Privacy</a></p>
</main></body></html>
`;
}
