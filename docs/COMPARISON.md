# Sparelimit compared with CodeBurn, ccusage and Claude Code's own `/usage`

**Read on 2026-11-26, from each project's public README or documentation. No code from any of them was installed or run.** Every cell below is something that page says, or is marked "not found on the page" or "not verified". Pages change: check the link and its date before you quote this. Quotes are short and are the projects' own words.

If you think a cell is wrong, open an issue and say which page says otherwise. It will be corrected and the date changed.

## What each one does

| | CodeBurn | ccusage | Claude Code (`/usage`, status line) | Sparelimit |
| :--- | :--- | :--- | :--- | :--- |
| **What it reports** | Spend by tool, model, project and task, across about 42 tools. [README](https://raw.githubusercontent.com/getagentseal/codeburn/main/README.md) | Daily, weekly, monthly and session reports for about 20 agent CLIs. [Repository](https://github.com/ryoppippi/ccusage) | A locally computed session cost, plan usage bars and a plan usage breakdown. [Costs](https://code.claude.com/docs/en/costs) | Spend by cause (re-sending the conversation, cold-cache returns, tool output kept in context), for Claude Code in full and Codex, Gemini and Cursor in part. Its own README |
| **Warns or stops while you work** | Yes, opt-in. "Guard" installs Claude Code hooks that warn at $5 and stop at $15, and cover loops and repeated failing commands. README | Not found on the page. It has a 5-hour blocks report and a beta status line that displays. Repository | Not as a guard. Spend limits are admin settings on Team and Enterprise. A context warning exists. Costs, [Commands](https://code.claude.com/docs/en/commands) | Yes: hooks and a status line warn on context size, cold cache and plan-limit pace. Its own README |
| **Plan limits (5-hour, weekly)** | `codeburn quota` reads the live limits from tools you are signed in to; it says it "does not predict" when you will run out. README | A 5-hour blocks report; no limit values given. Repository | The status line receives `rate_limits.five_hour` and `rate_limits.seven_day` percentages for subscribers. [Status line](https://code.claude.com/docs/en/statusline) | Estimates the limits from your logs and a calibration, and forecasts. Labelled estimated. Its own README |
| **Dollars** | "What your tokens would have cost at API rates", "not an invoice". README | Costs in USD per day, month and session. Whether it says they are list price: not found on the page | Computed locally at list price; "isn't relevant for billing" on a subscription. Costs | API-equivalent at list price, labelled so |
| **Where it runs, what leaves the machine** | Local. The CLI "sends nothing"; the desktop app, menu bar and tray can send an anonymous usage report, on by default per its README | Local. "At most one usage ping per UTC day" in official releases; opt out with `DO_NOT_TRACK=1` | Computed locally. Whether any data leaves: not verified (the privacy page was not read) | Local. No telemetry, and nothing is sent |

## What each one does after a fix or a warning

This is the row that matters for the claim Sparelimit makes, so it is on its own.

| | After a fix or warning is applied |
| :--- | :--- |
| **CodeBurn** | It measures afterwards. Its README says that `codeburn act report` "checks what each fix promised against what your sessions actually did", including fixes that changed nothing, and that "Compare periods" is for finding out "whether the change actually cost less". It also gives a saving estimate per finding before the fix. |
| **ccusage** | Not found on the page. |
| **Claude Code `/usage`** | Its recommendations say how much of your usage a row applies to, "not how much the change saves". The page does not say it re-measures. |
| **Sparelimit** | It measures afterwards, in a narrower way: it counts a saving only when an alert fired, you acted on it, and a lower cost was measured on the other side, under rules that are public and versioned ([RULES.md](RULES.md)). It does not say the alert caused the fall. See [what Sparelimit does not claim](../README.md#what-sparelimit-does-not-claim). |

## What this table does and does not show

- **It does not show that Sparelimit is better.** CodeBurn does more than Sparelimit in several rows (more tools, a guard with caps, a desktop app, a fix-applying command). ccusage is the broad, long-standing reporter. Claude Code now shows plan-limit percentages and some recommendations itself.
- **"Nobody measures savings" is not true.** CodeBurn re-measures after a fix. Sparelimit's claim is narrower: one rule set fixed in advance, public and versioned, applied to alerts raised live, counting nothing unless you acted.
- **That narrower claim has a weak base today.** All three savings counted on the author's machine come from the plan-limit method, which assumes the earlier pace would have continued. Most alerts were ignored. One machine, one person.
- **Not verified:** whether Claude Code's `/usage` or status line send anything off the machine; how CodeBurn's `act report` judges "what each fix promised" in detail (only the README's summary was read); ccusage's pricing basis.

## Sources, all read 2026-11-26

- CodeBurn: <https://raw.githubusercontent.com/getagentseal/codeburn/main/README.md>
- ccusage: <https://github.com/ryoppippi/ccusage> (the raw README points to `apps/ccusage/README.md`; the repository page renders it)
- Claude Code: <https://code.claude.com/docs/en/costs>, <https://code.claude.com/docs/en/statusline>, <https://code.claude.com/docs/en/commands>

Some passages of the CodeBurn and Claude Code pages were read through a summary rather than verbatim; the quoted words above are the ones read verbatim.
