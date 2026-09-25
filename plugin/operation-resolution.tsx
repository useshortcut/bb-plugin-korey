import { useState } from "react";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { operationResolutionPayloadSchema } from "./contracts.js";

export function OperationResolution({
  interaction,
  submit,
  cancel,
}: PluginPendingInteractionProps) {
  const parsed = operationResolutionPayloadSchema.safeParse(
    interaction.payload,
  );
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const busy = submittingId === interaction.id;
  const dismiss = () => void cancel().catch(() => undefined);
  if (!parsed.success) {
    return (
      <div className="space-y-3 text-sm">
        <p>This operation resolution request is invalid.</p>
        <button type="button" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    );
  }
  const payload = parsed.data;
  const confirm = async () => {
    setSubmittingId(interaction.id);
    try {
      await submit({
        confirmed: true,
        operationId: payload.operationId,
        resolutionHash: payload.resolutionHash,
      });
    } catch {
      setSubmittingId((current) =>
        current === interaction.id ? null : current,
      );
    }
  };
  return (
    <div className="space-y-4 text-sm">
      <p>
        Confirm only after inspecting Korey and Shortcut. This closes the local
        operation and allows later Shortcut requests to proceed. It does not
        cancel work in Korey or verify a Shortcut result.
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2">
        <dt>Operation</dt>
        <dd className="break-all font-mono">{payload.operationId}</dd>
        <dt>Status</dt>
        <dd>{payload.status}</dd>
        <dt>Conversation</dt>
        <dd className="break-all">{payload.koreyThreadId ?? "Unknown"}</dd>
      </dl>
      <div>
        <p className="font-medium">Original instruction</p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-sans">
          {payload.instruction}
        </pre>
      </div>
      <div>
        <p className="font-medium">Resolution note</p>
        <pre className="whitespace-pre-wrap break-words font-sans">
          {payload.note}
        </pre>
      </div>
      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1.5 disabled:opacity-50"
          disabled={busy}
          onClick={dismiss}
        >
          Cancel
        </button>
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground disabled:opacity-50"
          disabled={busy}
          onClick={() => void confirm()}
        >
          {busy ? "Resolving..." : "Confirm manual resolution"}
        </button>
      </div>
    </div>
  );
}
