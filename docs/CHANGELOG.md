# Changelog of the ledger's rules

The ledger is the judge: it decides which alerts count as a saving. A judge that changes its rules after seeing the work is not one, so the rules have a version, and this file is where each version is recorded.

**The policy.** Any change to a rule or a number in [RULES.md](RULES.md) is a new version. The new version gets a new entry here and in `rules-lock.json`. The entry of an earlier version is never edited: its numbers stay as they were, so anyone can see what was judged under which rules. A saving that was counted under one version is not recounted under another; `sparelimit ledger --json` prints the version it used.

A test fails if a rule or number changes without a new version, if an earlier version's entry in `rules-lock.json` is changed, or if a version has no entry in this file.

## Version 1 (written down on 2026-11-26)

The rules the ledger has used since it was built (the first counted alert in the author's log is from 2026-11-05). They were not changed to fit any result. What was written down on 2026-11-26 is the record of them: the numbers that were already in the code, gathered into one table, and a fingerprint of that table.

| Name | Value |
| :--- | :--- |
| `clusterGapMin` | 30 |
| `resetDropRatio` | 0.65 |
| `resetWithinResponses` | 15 |
| `minPreResponses` | 5 |
| `preResponses` | 10 |
| `postResponses` | 30 |
| `minPost` | 10 |
| `restartWithinMin` | 60 |
| `restartStartRatio` | 0.5 |
| `pendingHours` | 3 |
| `coldRestartWithinMin` | 45 |
| `coldCheckMin` | 5 |
| `coldPendingHours` | 1 |
| `coldFirstResponses` | 3 |
| `rateMinutes` | 30 |
| `rateSlowdown` | 0.7 |
| `rateMinBeforeUSD` | 0.5 |
| `rateMinResponses` | 5 |


Before this version, seven of these numbers (`clusterGapMin`, `resetWithinResponses`, `minPreResponses`, `restartStartRatio`, `coldCheckMin`, `coldPendingHours`, `coldFirstResponses`) were written inside the code instead of in the table. Their values did not change. In the `--json` output of a counted cold-cache entry, the field `after.first3ResponsesUSD` is now `after.firstResponsesUSD`, with the number of responses beside it.
