# Project Notes

This repository contains version 0.1.0 of the `/goal` command for Claude Code.

## Development

- Runtime entry point: `.claude/scripts/goal-helper.mjs`
- Slash command: `.claude/commands/goal.md`
- Stop hook wiring: `.claude/settings.json`
- Tests: `tests/goal-command.test.mjs`

Use Node 18 or newer for the test suite:

```bash
npm test
```

The runtime helper is intentionally kept compatible with Node 12.22+ because
Claude Code installations can run the command in older Node environments.
Avoid optional chaining, nullish coalescing, and `crypto.randomUUID()` in
`.claude/scripts/goal-helper.mjs`.

## Release Checklist

Before tagging a release:

1. Run `npm test`.
2. Run `node --check .claude/scripts/goal-helper.mjs`.
3. Smoke-test the heredoc invocation path from `SMOKE_TEST.md`.
4. Confirm `goal-state/goals.json` is ignored and absent from the commit.
5. Confirm public docs are up to date.

