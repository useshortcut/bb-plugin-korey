# Developing the Korey plugin

Run the commands below from the repository root. For connector setup and
everyday use, see the [README](../README.md).

TypeScript source, tests, test helpers, and the Vitest configuration live in
`plugin/`.

Use the Bun version pinned in `package.json` and Node.js 24, as specified in
`.nvmrc`:

```sh
nvm use
bun install --frozen-lockfile
bun run check
bb plugin install .
```

`bunfig.toml` requires newly resolved package versions to be at least one day
old. This applies to direct and transitive dependencies; existing lockfile
entries remain unchanged during frozen installs.

CI uses a task matrix on Blacksmith Linux runners with the Node.js version in
`.nvmrc` and the Bun version in `package.json`. Linting, formatting, SDK dependency
pins, TypeScript type checking, tests, plugin builds, and generated OpenAPI code
checks each run as a separate job with the same setup. `bun run check` runs all of
these checks locally.

`bun run lint` runs Oxlint, and `bun run check:format` checks formatting with
Oxfmt. Use `bun run format` to apply formatting. Generated files and local tool
state are excluded from linting and formatting; `bun run check:openapi` regenerates
the OpenAPI client and checks it for uncommitted changes.

The `validate-production-build` CI job tests production-only installs with
lifecycle scripts and optional dependencies disabled, then builds all three
entries using bb 0.43.4. This checks that users can build the plugin from
a managed Git install, without relying on development dependencies or code
generation during installation. It does not publish or deploy anything.

The manifest requires bb 0.43.4 or newer and plugin SDK 0.5.9 or newer. The
development SDK is pinned to 0.5.9 for bb 0.43.4. The test suite exercises the
SDK 0.5.9 backend and UI harnesses; live compatibility with another bb version
needs a separate smoke test, including resolution forms, host RPC, and other
experimental runtime surfaces.
macOS descriptor validation runs with mocked `lsof` output on Linux; CI does
not run a real macOS host.

Runtime imports that bb does not provide belong in `dependencies`; SDK types,
React, and development tools belong in `devDependencies`.

Local installations of the earlier test package use a different plugin
identity and storage namespace. Reconfigure the token and relink conversations
after installing `bb-plugin-korey`; no unpublished test state is migrated.

## Dependencies

`zod` is the only production dependency. The plugin uses it for API response
validation and its own contracts. bb supplies the SDK and React at runtime.

The development dependencies support these tasks:

- `@get-bb/plugin-sdk` and `bb-app` provide SDK declarations, test harnesses,
  compatibility checks, and plugin builds.
- `typescript` and the `@types/*` packages type-check the plugin, tests, and SDK
  declarations with `skipLibCheck: false`.
- `vitest`, `@testing-library/react`, `jsdom`, `react`, and `react-dom` run the
  backend and frontend tests.
- `better-sqlite3`, `cron-parser`, and `hono` are peers used by the SDK's backend
  test harness. SQLite is also imported directly by the storage tests.
- `node-gyp` supports the native build step Bun invokes during clean SQLite
  installs, including development and CI installations.
- `oxlint`, `oxfmt`, and `typed-openapi` run the lint, formatting, and OpenAPI
  generation scripts.

The remaining 16 UI packages are required by bb 0.43.4's SDK compatibility check:
`@pierre/diffs`, the `@radix-ui/*` entries, `class-variance-authority`, `clsx`,
`sonner`, `tailwind-merge`, and `vaul`. Our code does not import them. bb scaffolds
their development dependency pins for app plugins and supplies their runtime
implementations. Removing these entries makes `bun run check:sdk` fail even when
the plugin does not use those components. Revisit them if bb makes this check
depend on the plugin's actual imports.

Keep bb-managed version ranges when updating dependencies; the lockfile can
still select newer compatible releases within those ranges. `@types/node`
tracks Node.js 24, and `@types/better-sqlite3` stays on 7.x to satisfy the SDK's
peer dependency. Newer SDK and Sonner versions must wait for a compatible bb
release.

## API contract

`korey.openapi.json` is a pinned copy of Korey's public OpenAPI document.
`generated/korey-api.ts` is committed because managed Git installs disable
lifecycle scripts and omit development dependencies. Refresh both deliberately:

```sh
bun run openapi:sync
bun run generate:openapi
git diff -- korey.openapi.json generated/korey-api.ts
```

Generation preserves OpenAPI's default of allowing additional properties when
`additionalProperties` is omitted. Explicitly closed schemas stay strict in the
generated file. The client derives tolerant response schemas from that file:
it ignores extra fields and displays unknown content blocks as placeholders
with Korey links. Known required fields remain validated. New request and resolution
schemas stay strict.

`check:openapi` compares generated code with the pinned local spec. It does not
fetch Korey's live spec or fail just because Korey changes its public API.

Mutation POSTs are never retried automatically and never follow redirects.
Only a documented rejection for the specific endpoint is classified as a
definite failure. For example, the pinned message endpoint does not list `400`
or `422`; those responses remain uncertain until inspected. A status code alone
does not establish that a write had no effect. Response polling uses bounded
backoff for transient network errors, `429`, and `5xx`, and honors `Retry-After`.

Journals retain versioned request snapshots and the exact dispatched text.
Reading history does not validate it against the current request schema;
reconciliation uses recorded text, with a version 1 fallback for older journals.
Shortcut operations use request version 2; general connector changes through
`korey_ask` use version 3 with `action: "change"`. Both begin in `requested`
without an approval timestamp and share dispatch, unresolved-operation checks,
and recovery. General requests retain the same attachment hashes and exact
dispatched text as Shortcut requests. Version 1 journals retain their original prompts
and approval history. Pending approval rows from older plugin versions are
cancelled on reload and are never dispatched automatically.
Unresolved operations can be closed locally through the confirmed
`operation resolve` flow described in [usage](usage.md).

Live Korey behavior still needs verification for readiness revision updates and
verbatim message storage. Mapping recovery first searches the marker, then scans
owned threads if search misses; each traversal stops after 20 pages. The public
spec retrieved on 2026-09-24 lists `threads:read` and `threads:write`; the README
uses those names, but token creation was not tested against an account.

## Distribution

This repository is intentionally marked `private` in `package.json` to prevent
accidental npm publication. bb's managed Git installer installs runtime
dependencies with scripts disabled and builds the server, app, and host
artifacts itself.

The repository root is the plugin: `package.json` declares the server, app,
host, and skill entries. No bb checkout, collection manifest, or committed
build output is required. The Git install tracks the default branch; use
`bb plugin outdated` to inspect updates and `bb plugin update korey` to apply
one. To pin a particular commit, install
`git:https://github.com/useshortcut/bb-plugin-korey.git@<commit-sha>` instead.

## Branding

`assets/korey-mark.svg` is the compact mark used by Korey's browser extension.
The full logos use the paths from `KoreyLogo.tsx` in the Korey web app, with the
light and dark brand colors from `styles/colors.css` and the wordmark colors
from `KoreyLogo.module.css`. These sources live under `korey-frontend/` in the
Shortcut monorepo. Keep the plugin assets aligned with that artwork when Korey's
branding changes.

The manifest uses the compact mark for plugin icons and the full logos for
larger surfaces. The README selects the light or dark logo to match the reader's
theme.
