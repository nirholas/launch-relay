# AGENTS.md

Operating notes for AI coding agents (Claude Code, Codex, Cursor, Copilot and others) working in this repository. Everything here is derived from the files actually in the tree, so trust it over guesses, and update it when the facts change.

## What this repository is

A coin bonds on pump.fun. Seconds later a paired token for it exists on PAIR.fund, deployed from a rotating wallet, priced against the Robinhood Stock Token that actually fits the coin, with a launch plan that a human approved from their phone. None of that is hardcoded: sources, launchpads, chains, rotation, filtering, naming, and pairing

- Source: https://github.com/nirholas/launch-relay
- Primary language: JavaScript
- License: Other (see the LICENSE file)

## Repository layout

- `bin/`
- `config/`
- `contracts/`
- `deploy/`
- `docs/`
- `examples/`
- `site/`
- `src/`
- `test/`
- `tools/`
- `README.md`
- `LICENSE`
- `CONTRIBUTING.md`
- `package.json`
- `Dockerfile`

Tests live in `test/`. Add or update a test next to the code you change.

## Setup

```bash
npm install
```

## Commands

| Task | Command |
|---|---|
| start | `npm start` |
| test | `npm test` |
| lint | `npm run lint` |
| typecheck | `npm run typecheck` |
| build image | `docker build .` |

Run the test and lint commands above before you consider a change finished. If a command fails on code you did not touch, say so in your report instead of silently skipping it.

## Conventions

- `.env` files are gitignored; never commit credentials, and read configuration from environment variables.
- Commit messages follow Conventional Commits (`type(scope): summary`), matching the existing history.
- Read `CONTRIBUTING.md` before opening a pull request.
- Read the surrounding code before adding to it, and match its naming, file organisation and error-handling style.
- Keep `README.md` accurate: if a change alters behaviour, commands or configuration, update the docs in the same commit.
- Do not leave TODO comments, stub functions, placeholder data or commented-out code behind. Finish what you start or leave it out.
- Small, focused commits with a subject line that describes the change, not the act of committing.

## Where to raise things

- Bugs and feature requests: https://github.com/nirholas/launch-relay/issues
- Questions and ideas: https://github.com/nirholas/launch-relay/discussions
- Security issues: report privately at https://github.com/nirholas/launch-relay/security/advisories/new, never in a public issue.
