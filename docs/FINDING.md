# A finding: where one person's AI coding limit went

**Read on 2026-11-26 from 250 Claude Code sessions on one machine, one person, one Pro account.** Every figure comes from a command you can run on your own logs. Yours will differ, and these will change as the author keeps working. Dollars are API-equivalent at list price: on a subscription they show size and share of the limit, not an invoice.

## What was found

| Finding | Number | Label | Command |
| :--- | :--- | :--- | :--- |
| Total spend, all sessions | $5,941.99 | derived | `sparelimit replay --all` |
| Spend that was re-sending the conversation on every message | 58% ($3,447.54) | derived | `sparelimit replay --all` |
| Of that, the fixed starting context (system prompt, tools, memory) | 10% of all spend ($599.35) | derived | `sparelimit replay --all` |
| Adding new content to the conversation | 29% ($1,707.90) | derived | `sparelimit replay --all` |
| What the AI writes | 13% ($782.56) | derived | `sparelimit replay --all` |
| Coming back to a big conversation after the cache had gone cold | 221 times, $758.88 more than a warm cache would have cost | derived | `sparelimit replay --all` |
| Saving if every long session (176 of them) had been reset at 60% of the window | about 11% of spend (range $495.96 to $753.74) | **estimated** | `sparelimit replay --all` |
| Saving if each cold return had been a fresh start with a short handoff | about 10.6% of spend ($630.76) | **estimated** | `sparelimit replay --all` |

In one sentence: most of what the limit was spent on was not new work but the same conversation being read again, and a large part of that was after the cache had expired.

## How to check it on your own logs

```bash
git clone https://github.com/rotemalt/sparelimit.git
cd sparelimit
node sparelimit.mjs replay --all
```

Nothing is sent anywhere. If you have no Claude Code logs, it says so and says what to do next. How each figure is computed, and what the three labels mean: `node sparelimit.mjs method`. The rules are in [RULES.md](RULES.md) (rules version 1).

## What is weak

- **One machine, one person, one account type.** Nothing here says what your numbers are. It is a way to look at your own.
- **The two savings are models, not results.** They assume you would have acted on the warning, that the fresh start would have been clean, and about 25,000 tokens read again afterwards (the 11% and the 10.6% are different models of the same spend: they overlap and must not be added).
- **The 11% has a wide range** ($495.96 to $753.74), because it depends on how much has to be re-read after each reset. That assumption is measured on real shrinks by `sparelimit rebuild`, and is not yet supported by enough of them (see the methodology page).
- **Cold-cache cost is derived, but "cold" depends on a cache lifetime** the logs show only indirectly. All 221 returns in this run were more than an hour after the previous message.
- **List price is not what was billed.** On a subscription, the dollars are a measure of size, not of money paid.
- **It was re-run on a growing set.** An earlier run on 2026-11-25 read 237 sessions and gave $5,838 and 215 cold returns, and a run earlier on 2026-11-26 read 242; the newer sessions are the difference. Figures from different days are not comparable without saying so.
- **Spent after the first stop** ($1,510.94 in this run) is money spent later in those sessions. It is not a saving, and the tool says so.

## What this does not show

It does not show that any tool, this one included, would have saved this money. It shows where the limit went in one person's logs, and how to look at your own.
