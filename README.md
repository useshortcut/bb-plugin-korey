# bb-plugin-korey

A BB plugin maintained by Shortcut for consulting Korey from any provider, maintaining a
private Korey conversation per BB thread, attaching workspace files, and
sending explicitly approved Shortcut Story changes.

## Requirements

- BB 0.40.0 or newer.
- A Korey personal access token with `threads:read:own` and `threads:write`.
- Linux, WSL2, or macOS for workspace file attachments.
- The BB desktop or web app for Shortcut approval prompts. Third-party plugin
  interactions are not currently rendered by the native mobile app.

## Install

Install from this repository's default branch:

```sh
bb plugin install https://github.com/useshortcut/bb-plugin-korey
```

For local development:

```sh
nvm use
npm ci
bb plugin install .
```

Add the Korey token under **Settings -> Installed plugins -> Korey**, then verify it:

```sh
bb korey status
bb korey threads
```

This repository is intentionally marked `private` in `package.json` to prevent
accidental npm publication. BB's managed Git installer installs runtime
dependencies with scripts disabled and builds the server, app, and host
artifacts itself.

The repository root is the plugin: `package.json` declares the server, app,
host, and skill entries. No BB checkout, collection manifest, or committed
build output is required. The Git install tracks the default branch; use
`bb plugin outdated` to inspect updates and `bb plugin update korey` to apply
one. To pin a particular commit, install
`git:https://github.com/useshortcut/bb-plugin-korey.git@<commit-sha>` instead.

## Use

Ask Korey for analysis or a draft from an agent tool or the CLI:

```sh
bb korey ask "Turn this discussion into a draft Shortcut Story"
bb korey ask "Review these files" --file spec.md --file screenshot.png
```

Link an existing private Korey conversation when needed:

```sh
bb korey threads "checkout"
bb korey link <korey-thread-id>
```

Request a Shortcut write:

```sh
bb korey shortcut create "Create the reviewed bug Story" --file screenshot.png
bb korey shortcut update SC-123 "Add the approved acceptance criterion"
```

The Shortcut command does not accept `--yes`. It pauses and displays a BB-owned
approval form containing the exact action, Story ID, Korey organization and
conversation revision, instruction, attachment sizes, attachment SHA-256
hashes, and any unresolved earlier Shortcut operations. Nothing write-intended
is sent to Korey unless that form is approved. BB cannot inspect or bind the
server-side Shortcut connector configuration used by Korey.

Native tools expose the same capabilities:

- `korey_status`
- `korey_list_threads`
- `korey_get_thread`
- `korey_link_thread`
- `korey_unlink_thread`
- `korey_ask`
- `korey_shortcut_change`
- `korey_list_operations`
- `korey_get_operation`
- `korey_resume_operation`
- `korey_reconcile_operation`

## Operation Recovery

Every Shortcut request has a durable operation ID and SQLite journal. The
plugin records the immutable approved request, destination, attachment hashes,
uploaded attachment IDs, Korey thread ID, and Korey message ID as they become
available.

Inspect recent operations:

```sh
bb korey operation list
bb korey operation show <operation-id>
```

If Korey accepted the message but response polling failed, resume only the
read-only poll:

```sh
bb korey operation resume <operation-id>
```

If message dispatch had an unknown outcome, reconcile the existing operation
against the linked Korey history:

```sh
bb korey operation reconcile <operation-id>
```

Reconciliation never resends the message. An absent history match does not
prove that Shortcut made no change, so inspect Korey and Shortcut before asking
for another approval.

Important operation states:

| State                | Meaning                                                             |
| -------------------- | ------------------------------------------------------------------- |
| `awaiting-approval`  | BB is waiting for the user-owned approval form.                     |
| `awaiting-response`  | Korey recorded the message; response polling can resume safely.     |
| `korey-complete`     | Korey finished the turn; the Shortcut result still requires review. |
| `definite-failure`   | No Shortcut-intended message was dispatched.                        |
| `reconcile-required` | Message dispatch may have succeeded; never resend automatically.    |

## Safety Model

`korey_shortcut_change` uses a server-managed, single-use interaction instead
of an agent-supplied confirmation boolean. The approved snapshot is checked
again after conversation serialization, so changing the linked Korey thread
or its revision invalidates the approval. Concurrent work for one linked
conversation is serialized, and first-use mappings are claimed transactionally
before a remote thread is created. The next approval displays unresolved
operations from either the current BB thread or the destination Korey
conversation, including operations from another BB thread before relinking.
Approval is invalidated if that snapshot changes before dispatch.

This protects the normal BB tool and CLI flow; it is not a cryptographic
authorization boundary against malicious code already running with the user's
full BB credentials. BB plugins and coding agents are trusted local software.

Korey's public API has no idempotency key or structured Shortcut mutation
result. The plugin therefore cannot promise exactly-once Shortcut writes. It
never automatically repeats a message whose dispatch may have started, and a
Korey `complete` response is not proof that Shortcut committed exactly one
change. Always review the resulting Story.

`korey_ask` prefixes consultation requests with an instruction not to modify
connected systems. This is prompt-mediated, not a connector capability
sandbox. Use a Korey workspace and connector permissions appropriate for the
data and actions available to Korey. Consultation messages include a unique
reference so an ambiguous message response can be reconciled against Korey
history; if no exact match is visible, inspect the conversation rather than
resending automatically.

## File Attachments

Paths are relative to the BB thread workspace. The host entry opens and checks
the actual file descriptor, rejects absolute paths, traversal, external
symlinks, non-files, unsupported extensions, duplicate files supplied through
path aliases or hard links, and files that grow beyond their limit while being
read.

Korey's current byte limits are enforced before creating a conversation or
showing approval:

| Type   | Extensions                               | Per-file limit |
| ------ | ---------------------------------------- | -------------- |
| Images | `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` | 3 MiB          |
| PDF    | `.pdf`                                   | 2.5 MiB        |
| Text   | `.txt`, `.md`, `.csv`                    | 0.5 MiB        |

Up to five files can be uploaded per request and 25 files can be stored on one
Korey thread. Korey also limits PDFs to 100 pages, rejects password-protected
PDFs, and applies additional image/PDF validation remotely; those checks are
not available locally before upload.

## API Contract

`korey.openapi.json` is a pinned copy of Korey's public OpenAPI document.
`generated/korey-api.ts` is committed because managed Git installs disable
lifecycle scripts and omit development dependencies. Refresh both deliberately:

```sh
npm run openapi:sync
npm run generate:openapi
git diff -- korey.openapi.json generated/korey-api.ts
```

Mutation POSTs are never retried automatically and never follow redirects.
Redirects and undocumented response statuses during message dispatch leave the
operation available for reconciliation. Response polling uses bounded backoff
for transient network errors, `429`, and `5xx` responses and honors `Retry-After`.

## Development

TypeScript source, tests, test helpers, and the Vitest configuration live in
`plugin/`.

Use Node.js 24, as specified in `.nvmrc`:

```sh
nvm use
npm ci
npm run generate:openapi
git diff --exit-code -- generated/korey-api.ts
npm run check
```

CI runs these checks on Blacksmith Linux runners using the Node.js version in
`.nvmrc`. CI also regenerates the OpenAPI client and checks for uncommitted changes.
`npm run check` verifies formatting, SDK dependency pins, types, tests, and builds
for the server, app, and host entries. Use `npm run format` to apply formatting.

A separate CI job tests production-only installs with lifecycle scripts and
optional dependencies disabled, then builds all three entries using BB 0.40.0
and 0.43.4. This checks that users can build the plugin from a managed Git install,
without relying on development dependencies or code generation during installation. It
does not publish or deploy anything.

The development SDK is pinned to 0.5.9 for BB 0.43.4; the runtime contract requires
SDK 0.4.10 or newer. Runtime imports that BB does not provide belong in
`dependencies`; SDK types, React, and development tools belong in `devDependencies`.

Local installations of the earlier test package use a different plugin
identity and storage namespace. Reconfigure the token and relink conversations
after installing `bb-plugin-korey`; no unpublished test state is migrated.

## License

MIT. See [LICENSE](LICENSE).
