# Using Korey from BB

For setup and example requests, start with the [README](../README.md).
Connectors, their permissions, and reauthentication are managed in Korey.
The plugin uses your Korey personal access token to continue private
conversations from BB.

## CLI and agent tools

Use the CLI to ask Korey to research your connected tools, answer questions, or
prepare a draft. The same requests are available to every BB harness through the
plugin’s agent tools:

```sh
bb korey ask "Summarize the Sentry errors introduced in our latest release"
bb korey ask "Review these files" --file spec.md --file screenshot.png
```

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

Workspace file attachments require Linux, WSL2, or macOS. Paths are relative to
the BB thread workspace. The host entry opens and checks
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
