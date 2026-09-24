import { useState } from "react";
import {
  definePluginApp,
  type PluginPendingInteractionProps,
} from "@get-bb/plugin-sdk/app";
import {
  SHORTCUT_APPROVAL_RENDERER_ID,
  shortcutApprovalPayloadSchema,
} from "./contracts.js";

function ShortcutApproval({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const parsed = shortcutApprovalPayloadSchema.safeParse(interaction.payload);
  const [submittingInteractionId, setSubmittingInteractionId] = useState<
    string | null
  >(null);
  const busy = submittingInteractionId === interaction.id;

  if (!parsed.success) {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-destructive-text">
          This Shortcut approval request is invalid and cannot be executed.
        </p>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 font-medium"
          onClick={() => void cancel().catch(() => undefined)}
        >
          Dismiss
        </button>
      </div>
    );
  }

  const payload = parsed.data;
  const approve = async () => {
    setSubmittingInteractionId(interaction.id);
    try {
      await submit({
        approved: true,
        operationId: payload.operationId,
        payloadHash: payload.payloadHash,
      });
    } catch {
      setSubmittingInteractionId((current) =>
        current === interaction.id ? null : current,
      );
    }
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-md border border-attention/50 bg-surface-attention p-3 text-warning-text">
        Korey will be asked to perform an external Shortcut write. Review the
        exact request before approving it. BB cannot inspect or bind Korey's
        server-side Shortcut connector configuration.
      </div>

      {payload.unresolvedOperations.length > 0 ? (
        <div className="space-y-2 rounded-md border border-destructive/50 bg-surface-attention p-3 text-destructive-text">
          <p className="font-semibold">
            Earlier Shortcut operations are unresolved. They may already have
            changed Shortcut, so this request could duplicate a change.
          </p>
          <ul className="space-y-2">
            {payload.unresolvedOperations.map((operation) => (
              <li key={operation.operationId}>
                <span className="font-mono text-xs">
                  {operation.operationId}
                </span>{" "}
                is {operation.status} ({operation.action}
                {operation.storyId ? ` ${operation.storyId}` : ""}).
              </li>
            ))}
          </ul>
          <p>
            Inspect those operations, Korey, and Shortcut before approving a
            later write.
          </p>
        </div>
      ) : null}

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
        <dt className="font-medium text-muted-foreground">Action</dt>
        <dd className="font-semibold capitalize text-foreground">
          {payload.action} Shortcut Story
        </dd>
        {payload.storyId ? (
          <>
            <dt className="font-medium text-muted-foreground">Story</dt>
            <dd className="font-mono text-foreground">{payload.storyId}</dd>
          </>
        ) : null}
        <dt className="font-medium text-muted-foreground">Korey workspace</dt>
        <dd className="break-all text-foreground">
          {payload.koreyOrganization}
        </dd>
        <dt className="font-medium text-muted-foreground">Conversation</dt>
        <dd className="break-all text-foreground">
          {payload.destination.koreyThreadId ?? "New private conversation"}
        </dd>
        {payload.destination.koreyThreadRevision ? (
          <>
            <dt className="font-medium text-muted-foreground">
              Conversation revision
            </dt>
            <dd className="break-all font-mono text-xs text-foreground">
              {payload.destination.koreyThreadRevision}
            </dd>
          </>
        ) : null}
        <dt className="font-medium text-muted-foreground">Operation</dt>
        <dd className="break-all font-mono text-xs text-foreground">
          {payload.operationId}
        </dd>
      </dl>

      <div className="space-y-1.5">
        <p className="font-medium text-muted-foreground">Instruction</p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-surface-raised p-3 font-sans text-sm text-foreground">
          {payload.instruction}
        </pre>
      </div>

      {payload.attachments.length > 0 ? (
        <div className="space-y-1.5">
          <p className="font-medium text-muted-foreground">Attached files</p>
          <ul className="space-y-2 rounded-md border border-border p-3">
            {payload.attachments.map((file) => (
              <li key={`${file.sourcePath}:${file.sha256}`} className="min-w-0">
                <p className="break-all font-medium text-foreground">
                  {file.sourcePath}
                </p>
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {file.size.toLocaleString()} bytes · SHA-256 {file.sha256}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs leading-relaxed text-muted-foreground">
        Approval is single-use and bound to the action, instruction, Korey
        conversation revision, unresolved-operation snapshot, and attachment
        hashes shown above. Korey reports its own completion; verify the
        resulting Story in Shortcut.
      </p>

      <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 font-medium text-foreground disabled:opacity-50"
          disabled={busy}
          onClick={() => void cancel().catch(() => undefined)}
        >
          Cancel
        </button>
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground disabled:opacity-50"
          disabled={busy}
          onClick={() => void approve()}
        >
          {busy ? "Approving..." : "Approve Shortcut write"}
        </button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({
    id: SHORTCUT_APPROVAL_RENDERER_ID,
    component: ShortcutApproval,
  });
});
