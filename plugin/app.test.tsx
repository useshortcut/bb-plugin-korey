// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import {
  OPERATION_RESOLUTION_RENDERER_ID,
  type ConnectionView,
} from "./contracts.js";

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

it("describes manual closeout for a change in any connected service", () => {
  const properties = props(
    "flag-resolution",
    "korey-flag",
    async () => undefined,
  );
  properties.interaction.payload = {
    operationId: "korey-flag",
    resolutionHash: "c".repeat(64),
    status: "reconcile-required",
    instruction: "Enable checkout-v2 in staging.",
    koreyThreadId: "thread-one",
    note: "Verified the flag is enabled in LaunchDarkly.",
  };
  const slot = renderSlot(app.pendingInteractions[0]!, properties);
  expect(
    slot.getByText("Verified the flag is enabled in LaunchDarkly."),
  ).toBeTruthy();
  expect(slot.container.textContent).toContain(
    "inspecting Korey and the affected service",
  );
  expect(slot.container.textContent).not.toContain("Shortcut");
});

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

describe("Korey account settings", () => {
  const registration = () =>
    app.settingsSections.find(({ id }) => id === "korey-account")!;
  const authorizationUrl =
    "https://api.korey.ai/oauth/authorize?client_id=kc_client&state=s";
  const account = "bb User in example";

  // Models the server: a connected account takes precedence over the token.
  function koreyHost(initial: {
    connected: boolean;
    tokenSaved: boolean;
    error?: string;
  }) {
    const state = { ...initial };
    const view = (): ConnectionView => {
      const method = state.connected
        ? "oauth"
        : state.tokenSaved
          ? "token"
          : "none";
      return {
        method,
        account: method === "none" || state.error ? null : account,
        error: state.error ?? null,
        tokenSaved: state.tokenSaved,
      };
    };
    const rpc = {
      "connection.status": async () => view(),
      "connection.start": async () => ({ authorizationUrl }),
      "connection.complete": async () => {
        state.connected = true;
        return view();
      },
      "connection.disconnect": async () => {
        state.connected = false;
        return view();
      },
      "connection.removeToken": async () => {
        state.tokenSaved = false;
        return view();
      },
    };
    // Stands in for the browser callback completing on the server.
    const finishBrowserSignIn = () => {
      state.connected = true;
    };
    return { rpc, finishBrowserSignIn };
  }

  it("opens Korey sign-in and refreshes when the browser callback finishes", async () => {
    const korey = koreyHost({ connected: false, tokenSaved: false });
    const slot = renderSlot(registration(), {}, { rpc: korey.rpc });
    fireEvent.click(await slot.findByRole("button", { name: "Connect Korey" }));
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "openUrl", url: authorizationUrl },
      ]),
    );
    expect(slot.getByText("Open the Korey sign-in page")).toBeTruthy();

    korey.finishBrowserSignIn();
    await slot.behavior.emitRealtime("connection", null);
    expect(await slot.findByText(`Connected as ${account}.`)).toBeTruthy();
    expect(slot.queryByText("Open the Korey sign-in page")).toBeNull();
  });

  it("keeps a pending sign-in when an unrelated setting changes", async () => {
    const korey = koreyHost({ connected: false, tokenSaved: true });
    const slot = renderSlot(registration(), {}, { rpc: korey.rpc });
    fireEvent.click(await slot.findByRole("button", { name: "Connect Korey" }));
    expect(await slot.findByText("Open the Korey sign-in page")).toBeTruthy();
    await slot.behavior.emitRealtime("connection", null);
    await waitFor(() =>
      expect(
        slot.inspection.rpcCalls.filter(
          ({ method }) => method === "connection.status",
        ),
      ).toHaveLength(2),
    );
    expect(slot.getByText("Open the Korey sign-in page")).toBeTruthy();
  });

  it("finishes a sign-in from a pasted address and disconnects", async () => {
    const korey = koreyHost({ connected: false, tokenSaved: false });
    const slot = renderSlot(registration(), {}, { rpc: korey.rpc });
    fireEvent.click(await slot.findByRole("button", { name: "Connect Korey" }));
    const redirectUrl =
      "http://127.0.0.1:38886/api/v1/plugins/korey/http/oauth/callback?code=c&state=s";
    fireEvent.change(await slot.findByPlaceholderText("http://127.0.0.1:..."), {
      target: { value: redirectUrl },
    });
    fireEvent.click(slot.getByRole("button", { name: "Finish connecting" }));
    expect(await slot.findByText(`Connected as ${account}.`)).toBeTruthy();
    expect(slot.inspection.rpcCalls).toContainEqual({
      method: "connection.complete",
      input: { redirectUrl },
    });

    fireEvent.click(slot.getByRole("button", { name: "Disconnect" }));
    expect(
      await slot.findByText("Your Korey account is not connected."),
    ).toBeTruthy();
  });

  it("removes a saved personal access token after confirmation", async () => {
    const korey = koreyHost({ connected: false, tokenSaved: true });
    const slot = renderSlot(registration(), {}, { rpc: korey.rpc });
    expect(
      await slot.findByText(
        `bb is using the saved personal access token for ${account}.`,
      ),
    ).toBeTruthy();

    fireEvent.click(
      slot.getByRole("button", { name: "Remove personal access token" }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(slot.inspection.rpcCalls.map(({ method }) => method)).not.toContain(
      "connection.removeToken",
    );

    fireEvent.click(
      slot.getByRole("button", { name: "Remove personal access token" }),
    );
    expect(slot.getByText(/stays valid in Korey/u)).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Remove token" }));
    await waitFor(() =>
      expect(
        slot.queryByRole("button", { name: "Remove personal access token" }),
      ).toBeNull(),
    );
    expect(slot.getByText("Your Korey account is not connected.")).toBeTruthy();
  });

  it("explains that a saved token is a fallback while connected", async () => {
    const korey = koreyHost({ connected: true, tokenSaved: true });
    const slot = renderSlot(registration(), {}, { rpc: korey.rpc });
    expect(await slot.findByText(`Connected as ${account}.`)).toBeTruthy();
    expect(
      slot.getByText(
        /bb uses it only while your Korey account is disconnected/u,
      ),
    ).toBeTruthy();
    expect(slot.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    expect(
      slot.getByRole("button", { name: "Remove personal access token" }),
    ).toBeTruthy();
  });

  it("shows connection errors and still offers Disconnect", async () => {
    const korey = koreyHost({
      connected: true,
      tokenSaved: false,
      error: "Korey sign-in expired. Reconnect with `bb korey login`.",
    });
    const slot = renderSlot(registration(), {}, { rpc: korey.rpc });
    expect(await slot.findByText(/Korey sign-in expired/u)).toBeTruthy();
    expect(slot.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  });
});
