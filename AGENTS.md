# AGENTS.md

Update this doc if something is wrong/outdated.

## Project

- This is a repo of senko, ai cli coding agent that works in mac/linux terminal aiming to be fastest.

## Documentation

- Main documentation files are:
  - `README.md`: product overview, CLI usage, configuration, sessions, and resources.
  - `apps/cli/README.md`: published CLI package overview.
  - `docs/architecture.md`: runtime boundaries, storage, and performance policy.
  - `docs/commands.md`: slash-command behavior, implementation status, and research links.
  - `docs/inference-api.md`: future managed inference service contract.
  - `docs/releasing.md`: package release process.
- When implementation changes behavior, configuration, command status, architecture, the API contract, or the release workflow, update the relevant main documentation in the same change and keep overlapping descriptions consistent.

## Git

- Use conventional commit-style messages and PR titles: `type(scope): summary`. and always add details after summary with line break.
- e.g.,
`fix(ui): simplify thinking effort ui in cli

thinking effort ui was too complicated so changed icon and text to simplify.`

## Development

- Use Node.js 22.19.0 or newer and pnpm 10.34.1.
- Run `pnpm check` before handing off code changes.
- Keep the CLI independent from Pi's `~/.pi` and project `.pi` configuration.
- Do not add an inference API implementation under `apps/api` until that milestone is explicitly started. `apps/api` is only for users who wants to use Senko managed inference service.
