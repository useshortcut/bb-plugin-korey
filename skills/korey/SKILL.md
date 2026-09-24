---
name: korey
description: Consult Korey, inspect or link private Korey threads, attach supported workspace files, or request an interactively approved Shortcut Story create or update.
---

# Korey

Use `korey_ask` for product analysis, refinement, and drafting. The plugin asks
Korey not to modify connected systems and creates a private Korey conversation
when the current BB thread has no link. This restriction is prompt-mediated,
not a technical connector capability sandbox. If consultation dispatch has an
unknown outcome and no exact history match is visible, inspect the linked
conversation and do not resend automatically.

Use `korey_status`, `korey_list_threads`, `korey_get_thread`, and
`korey_link_thread` to inspect Korey and continue an existing private
conversation. Use `korey_unlink_thread` to remove the current BB-thread mapping
without changing the remote conversation. Follow pagination cursors when a
result reports `has_more`.

Use `korey_shortcut_change` only when the user requested the exact Shortcut
create or update. The tool has no confirmation argument. It displays a
single-use BB approval bound to the action, destination, instruction, and file
hashes before sending a write-intended message. The approval also shows any
earlier unresolved Shortcut operations; inspect them before approving a later
write.

Never call `korey_shortcut_change` again to retry a failed or unresolved
operation. Use `korey_get_operation` first. Use `korey_resume_operation` only
when its recorded state is `awaiting-response`; this resumes safe polling.
Use `korey_reconcile_operation` for `reconcile-required`; it reads Korey
history and never resends the request. If reconciliation finds no message,
inspect Korey and Shortcut manually.

To give Korey files, pass workspace-relative `files`. A request accepts up to
five distinct paths. Supported limits are 3 MiB for JPEG/PNG/GIF/WebP, 2.5 MiB
for PDF, and 0.5 MiB for plain text, Markdown, or CSV. Unsupported types,
absolute paths, traversal, and files outside the workspace are rejected before
Korey activity.

Equivalent commands and recovery operations are documented by
`bb korey --help`.
