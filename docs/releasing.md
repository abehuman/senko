# Releasing `@senkocode/cli`

Senko is published as the public npm package `@senkocode/cli`. The installed executable is named `senko`.

Publishing is intentionally a separate, state-changing operation. The repository's normal CI and release checks
build and pack the CLI but do not publish it.

## Prerequisites

- Be a member of the npm `senkocode` organization with permission to publish public packages.
- Use Node.js 22.19.0 or newer and pnpm 10.34.1.
- Authenticate to npm with an account or token that satisfies npm's publishing 2FA requirements.
- Start from a clean release commit on `main` with matching versions in `apps/cli/package.json` and
  `apps/cli/src/version.ts`.

The package metadata points to the public `abehuman/senko` GitHub repository. Keep its `repository`, `bugs`, and
`homepage` fields current. The first release can be published manually without trusted publishing.

## Verify the release candidate

```sh
pnpm install --frozen-lockfile
pnpm release:check
pnpm package
npm whoami
```

Inspect the generated `apps/cli/senkocode-cli-<version>.tgz` before publishing. The packed-install smoke test verifies
the executable permissions, help and version output, print mode, and a local mock inference request.

## Publish

The following command publishes to the public npm registry and must be run only when the release is approved:

```sh
npm publish ./apps/cli --access public
```

Senko pins pnpm 10, whose publish command delegates to the installed npm CLI. Publishing with npm directly from the
workspace root avoids pnpm-to-npm argument-forwarding differences. If npm reports root-owned files in `~/.npm`, use a
writable temporary cache for the release instead:

```sh
npm publish ./apps/cli --access public --cache /tmp/senko-npm-publish-cache
```

After npm accepts the release, verify the public artifact independently:

```sh
npm view @senkocode/cli version
npm install --global @senkocode/cli@0.1.0
senko --version
```

Create and push a matching `v0.1.0` Git tag only after the npm artifact has been verified.
