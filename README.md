# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Camotir7f/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Camotir7f/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is a small command-line tool that takes edits written by an AI model and applies them to a tree of text files. Models write edits in four different formats — unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches, and JSON text-editor tool calls — and mend reads all four, detecting the format automatically when you don't name one.

It finds the lines each edit names with three tiers of fuzzy matching, so drifted whitespace and indentation don't break a patch, and it applies every edit atomically: either all of them land, or nothing is written at all. Add `--check` for a dry run that changes nothing, `--strict` for exact-only matching, or `--format` to force one format.

## Run it

```sh
node main.ts fix.patch
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=0ra7tszs&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
