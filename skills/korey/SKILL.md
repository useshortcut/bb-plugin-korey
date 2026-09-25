---
name: korey
description: Ask Korey to research connected tools or carry out requested actions, including feature-flag changes and Shortcut Stories. Also use to inspect or link private Korey conversations and attach workspace files.
---

# Ask Korey

Korey provides shared access to its connectors across bb harnesses. Delegate the
user’s desired outcome and relevant context to Korey, and let it handle the
service-specific details using its connector access and workspace conventions.
Connector setup, credentials, and reauthentication are managed in Korey. If Korey
reports missing connector access, direct the user to that connector’s settings
in Korey.

## Route the request

Use `korey_ask` with `mode: "change"` when the user requests an action in a
connected service. For example, delegate LaunchDarkly feature-flag updates or
Sentry issue changes with the requested target, environment, and outcome.
The explicit user request authorizes the change; send it without a second
confirmation. Ask for clarification only if the change or destination is unclear.

Use `korey_ask` with `mode: "consult"` for research, questions, analysis, and
drafts. This is the default when mode is omitted. Korey is instructed to return
information without changing connected services for that request. Consultation
and change modes are prompt instructions; connector permissions remain in Korey.
The current bb thread gets a private Korey conversation on its first request
if no conversation is linked.

Use `korey_shortcut_change` when the user asks Korey to create or update a Shortcut
Story. Give Korey the requested outcome and supporting context. The user’s
explicit request authorizes that create or update; send it without requesting
a second confirmation. Ask for clarification only if the intended change or
destination is unclear. Korey handles the Story through its connector and
workspace conventions.

Both change routes share operation tracking. The plugin stops a new write if
an earlier operation from either route is unresolved. Follow the recovery steps
below before continuing. Consultation remains available to inspect the outcome.

## Continue a conversation

Use `korey_status`, `korey_list_threads`, `korey_get_thread`, and
`korey_link_thread` to inspect Korey and continue an existing private
conversation. Use `korey_unlink_thread` to remove the current bb-thread mapping
without changing the remote conversation. Follow pagination cursors when a
result reports `has_more`.

After relinking, recover the conversation's unresolved operations from the
current thread or their originating thread. The plugin blocks another link
change until inherited unresolved operations are recovered.

## Include workspace files

Pass workspace-relative `files` with the request. A request accepts up to five
distinct paths. Supported limits are 3 MiB for JPEG/PNG/GIF/WebP, 2.5 MiB for PDF,
and 0.5 MiB for plain text, Markdown, or CSV. Unsupported types, absolute paths,
traversal, and files outside the workspace are rejected before Korey activity.

## Recover an interrupted request

If consultation dispatch has an unknown outcome and no exact history match is
visible, inspect the linked conversation and do not resend automatically.

Never send another change through `korey_ask` or `korey_shortcut_change` to retry
an operation with an unknown outcome. Use `korey_get_operation` first.
Use `korey_resume_operation` only
when its recorded state is `awaiting-response`; this resumes safe polling.
Use `korey_reconcile_operation` for `reconcile-required`; it reads Korey
history and never resends the request. If reconciliation finds no message,
inspect Korey and the affected service and ask the user how to proceed. A
`definite-failure` means no change-request message was accepted; resolve the reported
problem before retrying the user’s request.

For equivalent CLI commands, use `bb korey --help`.

After the user has inspected Korey and the affected service and requests closeout, run
`bb korey operation resolve <operation-id> "<inspection result>"`. bb requires
the user's confirmation of the operation and note. `manually-resolved` records
local closeout; it does not verify completion or cancel work in Korey.
