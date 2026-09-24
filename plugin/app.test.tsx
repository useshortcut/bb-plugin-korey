// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ShortcutApprovalPayload } from "./contracts.js";

const app = await loadPluginApp(() => import("./app.js"));

afterEach(cleanup);

function payload(operationId: string): ShortcutApprovalPayload {
  return {
    operationId,
    payloadHash: "a".repeat(64),
    bbThreadId: "thread-test",
    action: "create",
    storyId: null,
    instruction: "Create the approved Story.",
    koreyOrganization: "example",
    destination: {
      kind: "linked-private-thread",
      koreyThreadId: "korey-thread-1",
      koreyThreadRevision: "2026-08-21T12:01:00.000Z",
      mappingGeneration: 1,
    },
    attachments: [],
    unresolvedOperations: [],
  };
}

function props(
  interactionId: string,
  operationId: string,
  submit: PluginPendingInteractionProps["submit"],
): PluginPendingInteractionProps {
  return {
    interaction: {
      id: interactionId,
      threadId: "thread-test",
      title: "Create Shortcut Story",
      payload: payload(operationId),
      createdAt: 0,
      expiresAt: null,
    },
    submit,
    cancel: async () => undefined,
  };
}

it("enables approval controls for the next interaction after submission", async () => {
  const registration = app.pendingInteractions[0];
  if (registration === undefined) {
    throw new Error("Missing Shortcut approval registration");
  }
  const submit = vi.fn(async () => undefined);
  const first = props(
    "interaction-one",
    "korey-11111111-1111-4111-8111-111111111111",
    submit,
  );
  const slot = renderSlot(registration, first);

  fireEvent.click(slot.getByRole("button", { name: "Approve Shortcut write" }));
  await waitFor(() => {
    expect(slot.getByRole("button", { name: "Approving..." })).toBeTruthy();
  });

  const Component = registration.component;
  slot.rerender(
    <Component
      {...props(
        "interaction-two",
        "korey-22222222-2222-4222-8222-222222222222",
        submit,
      )}
    />,
  );

  const approve = slot.getByRole("button", {
    name: "Approve Shortcut write",
  });
  const cancel = slot.getByRole("button", { name: "Cancel" });
  expect((approve as HTMLButtonElement).disabled).toBe(false);
  expect((cancel as HTMLButtonElement).disabled).toBe(false);
});
