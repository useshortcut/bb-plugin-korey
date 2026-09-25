// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { OPERATION_RESOLUTION_RENDERER_ID } from "./contracts.js";

const app = await loadPluginApp(() => import("./app.js"));

afterEach(cleanup);

it("shows the resolution note and binds confirmation to its snapshot", async () => {
  const registration = app.pendingInteractions.find(
    ({ id }) => id === OPERATION_RESOLUTION_RENDERER_ID,
  )!;
  const submit = vi.fn<PluginPendingInteractionProps["submit"]>(
    async () => undefined,
  );
  const properties = props("resolve-one", "korey-1", submit);
  properties.interaction.payload = {
    operationId: "korey-1",
    resolutionHash: "b".repeat(64),
    status: "reconcile-required",
    instruction: "Create a Story",
    koreyThreadId: "thread-one",
    note: "Verified SC-123 in Shortcut.",
  };
  const slot = renderSlot(registration, properties);
  expect(slot.getByText("Verified SC-123 in Shortcut.")).toBeTruthy();
  fireEvent.click(
    slot.getByRole("button", { name: "Confirm manual resolution" }),
  );
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith({
      confirmed: true,
      operationId: "korey-1",
      resolutionHash: "b".repeat(64),
    }),
  );
});

it.each([OPERATION_RESOLUTION_RENDERER_ID])(
  "rejects invalid interaction payloads and allows dismissal (%s)",
  async (id) => {
    const registration = app.pendingInteractions.find(
      (entry) => entry.id === id,
    )!;
    const submit = vi.fn<PluginPendingInteractionProps["submit"]>(
      async () => undefined,
    );
    const properties = props("invalid", "korey-1", submit);
    properties.interaction.payload = {};
    properties.cancel = vi.fn<PluginPendingInteractionProps["cancel"]>(
      async () => undefined,
    );
    const slot = renderSlot(registration, properties);
    fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(properties.cancel).toHaveBeenCalledOnce());
    expect(submit).not.toHaveBeenCalled();
  },
);

function payload(operationId: string) {
  return {
    operationId,
    resolutionHash: "a".repeat(64),
    status: "reconcile-required",
    instruction: "Create the requested Story.",
    koreyThreadId: "korey-thread-1",
    note: "Inspected Korey and Shortcut.",
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
      title: "Resolve Korey operation manually",
      payload: payload(operationId),
      createdAt: 0,
      expiresAt: null,
    },
    submit,
    cancel: async () => undefined,
  };
}

it("enables resolution controls for the next interaction after submission", async () => {
  const registration = app.pendingInteractions[0];
  if (registration === undefined) {
    throw new Error("Missing operation resolution registration");
  }
  const submit = vi.fn<PluginPendingInteractionProps["submit"]>(
    async () => undefined,
  );
  const first = props(
    "interaction-one",
    "korey-11111111-1111-4111-8111-111111111111",
    submit,
  );
  const slot = renderSlot(registration, first);

  fireEvent.click(
    slot.getByRole("button", { name: "Confirm manual resolution" }),
  );
  await waitFor(() => {
    expect(slot.getByRole("button", { name: "Resolving..." })).toBeTruthy();
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

  const confirm = slot.getByRole("button", {
    name: "Confirm manual resolution",
  });
  const cancel = slot.getByRole("button", { name: "Cancel" });
  expect((confirm as HTMLButtonElement).disabled).toBe(false);
  expect((cancel as HTMLButtonElement).disabled).toBe(false);
});
