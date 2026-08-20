# AGENTS.md

Update this doc if something is wrong/outdated.

## Project

- This is a repo of senko, ai cli coding agent that works in mac/linux terminal aiming to be fastest.

## Git

- Use conventional commit-style messages and PR titles: `type(scope): summary`. and always add details after summary with line break.
- e.g.,
`fix(ui): simplify thinking effort ui in cli

thinking effort ui was too complicated so changed icon and text to simplify.`

## Development

- Use Node.js 22.19.0 or newer and pnpm 10.34.1.
- Run `pnpm check` before handing off code changes.
- Keep the CLI independent from Pi's `~/.pi` and project `.pi` configuration.
- Do not add an inference API implementation under `apps/api` until that milestone is explicitly started.
