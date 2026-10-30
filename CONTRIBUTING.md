# Contributing

Alfred is a personal project built for one owner, but bug reports and fixes are welcome.

## Issues

- **Bugs:** use the bug report form. The most useful reports give a failing input, what happened and what you expected; a suggested fix is a bonus.
- **Security problems:** report them privately, see [SECURITY.md](SECURITY.md).
- **Feature ideas:** open an issue to discuss it first. Alfred stays small on purpose, so not every idea will fit.

## How the project is developed

Most of the code is written by Claude agents: an issue is the spec, an implementer delivers one pull request per issue, and an orchestrator reviews, re-runs the acceptance commands and merges. `CLAUDE.md` holds the rules those agents follow; they apply to human contributions too. In short:

- Read the design note in `docs/` for the area you touch, and keep it true.
- `npm run check` and `npm test` pass; iOS changes follow `ios/README.md` and `ios/CLAUDE.md`.
- No new dependencies without discussing it in an issue first.
- Commit messages and PR titles are plain imperative sentences ("Add …", "Fix …"), no type prefixes.
- PRs are merged with a merge commit.

## Pull requests

Link the issue, list the commands you ran and their results, and note anything that differs from the issue. The delivery record table in the template is for the orchestrator; leave it empty.
