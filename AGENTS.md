# AGENTS.md

Update this doc if something is wrong/outdated.

## Project

- This is a repo of senko, ai cli coding agent that works in mac/linux terminal aiming to be best for Japanese dev teams who want to optimize cost/stability of ai coding workflow by offering multi-model, multi-provider service.

## Documentation

- Main documentation files are:
  - `README.md`: Japanese product overview, CLI usage, configuration, sessions, and resources.
  - `README.en.md`: English version of the root README.
  - `apps/cli/README.md`: published CLI package overview.
  - `docs/positioning.md`: target customer, customer problems, product pillars, and messaging boundaries.
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

## Infra

- Postgres Database is hosted on Railway.
  - Project id: 366c6026-e485-4d4d-a3ea-399dc38410da
  - Service id: e34d6b6a-df9d-432e-be71-b6ab131cd499
  - Environment id: 79763594-b907-45b3-b76e-13b759b97237
  - We have multiple Postgres on Railway so When development/test, use service id 93f9494a-0e1b-4177-b84d-b24ac9b88b5f for database.
  - All are deployed as serverless mode (cold start) on Railway untill actual release.
