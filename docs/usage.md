# Using Korey from bb

For setup and example requests, start with the [README](../README.md).
Connectors, their permissions, and reauthentication are managed in Korey.
The plugin uses your [Korey personal access token](https://app.korey.ai/settings/api-tokens)
to continue private conversations from bb.

## CLI and agent tools

Use the CLI to ask Korey to research your connected tools, answer questions, or
prepare a draft. The same requests are available to every bb harness through the
plugin’s agent tools:

```sh
bb korey ask "Summarize the Sentry errors introduced in our latest release"
bb korey ask "Review these files" --file spec.md --file screenshot.png
```

To request a change through any of Korey's connected services, use `--change`:

```sh
bb korey ask --change "Enable LaunchDarkly flag checkout-v2 in the shop project's staging environment"
bb korey ask --change "Resolve Sentry issue SHOP-42"
```

For agents, `korey_ask` accepts `mode: "change"` for requested actions and
`mode: "consult"` for research, questions, and drafts. Omitted mode defaults to
`consult`. Prefer the dedicated `korey_shortcut_change` tool for Story creation
and updates. An explicit change request authorizes its dispatch without an
extra confirmation. The target and requested change must be clear.

Change mode returns an operation ID, state, and response using the recovery
flow below. Both change routes share the same journal and unresolved-operation
checks. Consultation remains available while an earlier change is unresolved.

If a message begins with `-`, put options before `--`, then the message:

```sh
bb korey ask --json -- "- Review this proposal"
```

Consultation results include `responseTruncated`. If it is `true`, open the
returned `appUrl` to read the full response, or retrieve messages with
`bb korey show <korey-thread-id>` and follow pagination. An empty `files` list
is equivalent to omitting attachments.

Link an existing private Korey conversation when needed:

```sh
bb korey threads "checkout"
bb korey link <korey-thread-id>
```

Ask Korey to create or update a Shortcut Story:

```sh
bb korey shortcut create "Create the reviewed bug Story" --file screenshot.png
bb korey shortcut update SC-123 "Add the approved acceptance criterion"
```

An explicit request to create or update a Story authorizes the change. The
command sends it directly to Korey without an extra approval form or `--yes`
flag. Agents should ask for clarification only when the requested change or
destination is unclear. Korey uses its connector and workspace conventions.

If an earlier operation is unresolved, the plugin stops before sending another
change and returns the operation ID with recovery steps. Inspect that operation
before deciding what to do next.

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

Every change request has a durable operation ID and SQLite journal. The
plugin records the immutable request, destination, attachment hashes,
uploaded attachment IDs, Korey thread ID, and Korey message ID as they become
available.

Inspect recent operations:

```sh
bb korey operation list
bb korey operation show <operation-id>
```

The list includes operations started in this bb thread and operations in its
currently linked Korey conversation. After relinking a conversation, you can
inspect, resume, reconcile, or manually resolve its operations from the new
thread. The originating bb thread also retains access. Recover unresolved
operations inherited from another thread before unlinking or changing the
conversation link.

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
prove that the connected service made no change, so inspect Korey and the
affected service before requesting another change.

After inspecting Korey and the affected service, close an unresolved operation
with a note:

```sh
bb korey operation resolve <operation-id> "Verified SC-123 contains the requested change"
```

bb displays the operation and note for your confirmation. This closeout form is
reserved for unresolved outcomes. Resolution allows later requests to proceed
and preserves the original request, error, note, and completion time. It does
not cancel remote work or verify that Korey completed it. A changed operation
invalidates the pending confirmation; the form expires after ten minutes.

`manually-resolved` records this user-confirmed closeout, distinct from a
`korey-complete` response.

Important operation states:

| State                | Meaning                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------- |
| `requested`          | The user’s request is recorded and preparation is about to start.                         |
| `awaiting-response`  | Korey recorded the message; response polling can resume safely.                           |
| `korey-complete`     | Korey finished the turn; the connected service's result still requires review.            |
| `manually-resolved`  | You confirmed local closeout after inspection; remote work is not verified or cancelled.  |
| `definite-failure`   | No change-request message was accepted.                                                   |
| `reconcile-required` | Message dispatch may have succeeded; never resend automatically.                          |
| `cancelled`          | A pending approval from an older plugin version was cancelled on reload without dispatch. |

## Safety Model

`korey_ask` in change mode and `korey_shortcut_change` act on the user's explicit
request. The plugin records the request, destination, and attachment hashes
before sending it. It checks conversation readiness, privacy, and revision,
serializes requests within each bb thread, and claims first-use mappings
transactionally. If the destination changes during preparation, no change
request is sent.

Unresolved operations from either the current bb thread or the destination
Korey conversation block a new write, including after a conversation is relinked
from another bb thread. The plugin checks again before message dispatch. Resume,
reconcile, or manually resolve the existing operation instead of submitting a
replacement whose effect may be duplicated.

Korey's public API has no idempotency key or structured connector mutation
result. The plugin therefore cannot promise exactly-once changes. It
never automatically repeats a message whose dispatch may have started, and a
Korey `complete` response is not proof that a connected service committed exactly
one change. Review the affected resources.

`korey_ask` in consult mode prefixes requests with an instruction not to modify
connected systems. Change mode asks Korey to carry out only the requested action;
the dedicated Shortcut tool asks for the specified Story create or update.
These instructions are prompt-mediated, not a connector capability sandbox.
Use a Korey workspace and connector permissions appropriate for the
data and actions available to Korey. Consultation messages include a unique
reference so an ambiguous message response can be reconciled against Korey
history; if no exact match is visible, inspect the conversation rather than
resending automatically.

## File Attachments

Workspace file attachments require Linux, WSL2, or macOS. Paths are relative to
the bb thread workspace. The host entry opens and checks
the actual file descriptor, rejects absolute paths, traversal, external
symlinks, non-files, unsupported extensions, duplicate files supplied through
path aliases or hard links, and files that grow beyond their limit while being
read.

Korey's current byte limits are enforced before creating a conversation or
sending a request:

| Type   | Extensions                               | Per-file limit |
| ------ | ---------------------------------------- | -------------- |
| Images | `.jpg`, `.jpeg`, `.png`, `.gif`, `.webp` | 3 MiB          |
| PDF    | `.pdf`                                   | 2.5 MiB        |
| Text   | `.txt`, `.md`, `.csv`                    | 0.5 MiB        |

Up to five files can be uploaded per request and 25 files can be stored on one
Korey thread. Korey also limits PDFs to 100 pages, rejects password-protected
PDFs, and applies additional image/PDF validation remotely; those checks are
not available locally before upload.
