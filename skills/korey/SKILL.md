---
name: korey
description: Ask Korey to research connected tools, prepare drafts, or create and update Shortcut Stories. Also use to inspect or link private Korey conversations and attach workspace files.
---

# Ask Korey

Korey provides shared access to its connectors across BB harnesses. Delegate the
user’s desired outcome and relevant context to Korey, and let it handle the
service-specific details using its connector access and workspace conventions.
Connector setup, credentials, and reauthentication are managed in Korey. If Korey
reports missing connector access, direct the user to that connector’s settings
in Korey.

## Route the request

Use `korey_ask` for research, analysis, and drafts across the services connected in
Korey. Examples include investigating Sentry errors, understanding LaunchDarkly
flags, and comparing a plan with existing Shortcut Stories. The plugin asks
Korey not to modify connected systems. This restriction is prompt-mediated,
not a technical connector permission boundary. The current BB thread gets a
private Korey conversation on its first request if no conversation is linked.

Use `korey_shortcut_change` when the user asks Korey to create or update a Shortcut
Story. Give Korey the requested outcome and supporting context so it can prepare
the Story through its connector. Call only for the exact create or update the
user requested. The tool has no confirmation argument: it displays a single-use
BB approval bound to the action, destination, instruction, and file hashes before
sending the request. The approval also shows earlier unresolved Shortcut
operations; inspect them before a later write.

This version provides an approved write flow for Shortcut Stories. Requests to
modify other connected services are not supported by the plugin.

## Continue a conversation

Use `korey_status`, `korey_list_threads`, `korey_get_thread`, and
`korey_link_thread` to inspect Korey and continue an existing private
conversation. Use `korey_unlink_thread` to remove the current BB-thread mapping
without changing the remote conversation. Follow pagination cursors when a
result reports `has_more`.

## Include workspace files

Pass workspace-relative `files` with the request. A request accepts up to five
distinct paths. Supported limits are 3 MiB for JPEG/PNG/GIF/WebP, 2.5 MiB for PDF,
and 0.5 MiB for plain text, Markdown, or CSV. Unsupported types, absolute paths,
traversal, and files outside the workspace are rejected before Korey activity.

## Recover an interrupted request

If consultation dispatch has an unknown outcome and no exact history match is
visible, inspect the linked conversation and do not resend automatically.

Never call `korey_shortcut_change` again to retry a failed or unresolved
operation. Use `korey_get_operation` first. Use `korey_resume_operation` only
when its recorded state is `awaiting-response`; this resumes safe polling.
Use `korey_reconcile_operation` for `reconcile-required`; it reads Korey
history and never resends the request. If reconciliation finds no message,
inspect Korey and Shortcut manually.

For equivalent CLI commands, use `bb korey --help`.

After the user has inspected Korey and Shortcut and requests closeout, run
`bb korey operation resolve <operation-id> "<inspection result>"`. BB requires
the user's confirmation of the operation and note. `manually-resolved` records
local closeout; it does not verify completion or cancel work in Korey.
