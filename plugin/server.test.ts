import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import type { ReadAttachmentResult } from "./attachments.js";
import { shortcutApprovalPayloadSchema } from "./contracts.js";
import {
  getMapping,
  listOperations,
  setLinkedMapping,
  transitionOperation,
} from "./data.js";
import koreyPlugin from "./server.js";
import { withHttpServer } from "./testing/http-server.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function identityResponse(): Response {
  return jsonResponse({
    sub: "user-sub",
    name: "BB User",
    email: "user@example.com",
    korey_user_id: 42,
    korey_organization_id: 7,
    korey_organization_slug: "example",
    role: "member",
  });
}

function koreyThread(
  id = "korey-thread-1",
  state = "ready",
  updatedAt = "2026-08-21T12:01:00.000Z",
) {
  return {
    id,
    name: "BB: Shape the feature",
    state,
    is_private: true,
    archived: false,
    owner: { id: "korey-user-1", name: "BB User" },
    created_at: "2026-08-21T12:00:00.000Z",
    updated_at: updatedAt,
    app_url: `https://app.korey.ai/threads/${id}`,
  };
}

function assistantMessage(
  text = "Here is the refined Story draft.",
  threadId = "korey-thread-1",
) {
  return {
    id: "assistant-message-1",
    thread_id: threadId,
    role: "assistant",
    contents: [{ type: "text", text }],
    created_at: "2026-08-21T12:01:00.000Z",
    app_url: `https://app.korey.ai/threads/${threadId}/messages/assistant-message-1`,
  };
}

function userMessage(
  text: string,
  id = "user-message-reconciled",
  attachmentIds: readonly string[] = [],
) {
  return {
    id,
    thread_id: "korey-thread-1",
    role: "user",
    contents: [
      { type: "text", text },
      ...attachmentIds.map((attachmentId) => ({
        type: "document",
        attachment_id: attachmentId,
      })),
    ],
    created_at: "2026-08-21T12:00:30.000Z",
    app_url: `https://app.korey.ai/threads/korey-thread-1/messages/${id}`,
  };
}

function completeResponse(text?: string, threadId?: string) {
  return jsonResponse({
    status: "complete",
    messages: [assistantMessage(text, threadId)],
  });
}

function messagePage(data: unknown[] = []) {
  return jsonResponse({
    data,
    first_id: data.length ? "first" : null,
    last_id: data.length ? "last" : null,
    has_more: false,
    limit: 200,
  });
}

type StubbedFetchResult = Error | Response | (() => Response);

function stubFetch(responses: StubbedFetchResult[]) {
  const calls: Array<{ init: RequestInit | undefined; url: string }> = [];
  const fetchImpl: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    const next = responses.shift();
    const response = typeof next === "function" ? next() : next;
    if (response === undefined) {
      throw new Error(`Unexpected fetch ${String(input)}`);
    }
    if (response instanceof Error) throw response;
    return response;
  };
  vi.stubGlobal("fetch", fetchImpl);
  return calls;
}

async function loadPlugin(
  options: {
    attachment?: ReadAttachmentResult;
    settings?: { apiToken?: string };
  } = {},
): Promise<FakePluginHost> {
  const host = createFakePluginHost({
    pluginId: "korey",
    agentSkillIds: ["korey"],
    settings: options.settings ?? { apiToken: "kt_pat_test" },
    experimental_callHostRpc: async () =>
      options.attachment ?? {
        filename: "spec.md",
        contentType: "text/markdown",
        base64: Buffer.from("The specification").toString("base64"),
        identity: "1:1",
      },
    sdk: {
      environments: {
        get: async () => ({
          id: "env-test",
          name: null,
          projectId: "project-test",
          hostId: "remote-host",
          path: "/workspace",
          managed: false,
          isGitRepo: true,
          isWorktree: false,
          workspaceProvisionType: "unmanaged",
          branchName: null,
          baseBranch: null,
          defaultBranch: null,
          mergeBaseBranch: null,
          status: "ready",
          createdAt: 0,
          updatedAt: 0,
        }),
      },
      threads: {
        get: async ({ threadId }) =>
          makeThreadResponse({
            id: threadId,
            title: "Shape the feature",
            environmentId: "env-test",
          }),
      },
    },
  });
  await koreyPlugin(host.bb);
  hosts.push(host);
  return host;
}

async function waitForApproval(host: FakePluginHost) {
  return vi.waitFor(
    () => {
      const pending = host.harness.pendingInteractions[0];
      if (pending === undefined) {
        throw new Error("Approval interaction was not created");
      }
      return {
        id: pending.id,
        payload: shortcutApprovalPayloadSchema.parse(pending.payload),
      };
    },
    { timeout: 1_000, interval: 5 },
  );
}

function approve(
  host: FakePluginHost,
  interaction: Awaited<ReturnType<typeof waitForApproval>>,
) {
  host.harness.submitInteraction(interaction.id, {
    approved: true,
    operationId: interaction.payload.operationId,
    payloadHash: interaction.payload.payloadHash,
  });
}

function storeMapping(host: FakePluginHost, koreyThreadId = "korey-thread-1") {
  setLinkedMapping(host.bb.storage.database(), "thread-test", koreyThreadId);
}

const hosts: FakePluginHost[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

describe("Korey plugin conversations", () => {
  it("creates one marked private thread and persists its mapping", async () => {
    const calls = stubFetch([
      jsonResponse({ thread_id: "korey-thread-1", message_id: null }, 201),
      jsonResponse(koreyThread()),
      jsonResponse({ message_id: "user-message-1" }, 201),
      completeResponse(),
    ]);
    const host = await loadPlugin();

    const result = await host.harness.callAgentTool("korey_ask", {
      prompt: "Turn the current discussion into a Story draft.",
    });

    expect(result).toBeTypeOf("string");
    expect(JSON.parse(String(result))).toMatchObject({
      created: true,
      koreyThreadId: "korey-thread-1",
      response: "Here is the refined Story draft.",
    });
    expect(getMapping(host.bb.storage.database(), "thread-test")).toMatchObject(
      {
        koreyThreadId: "korey-thread-1",
        state: "ready",
      },
    );
    const createBody = JSON.parse(String(calls[0]?.init?.body));
    expect(createBody).toMatchObject({ is_private: true });
    expect(createBody.name).toMatch(
      /^BB: Shape the feature \[bb-korey:[a-f0-9-]+\]$/u,
    );
    expect(JSON.parse(String(calls[2]?.init?.body)).text).toContain(
      "This request is consultation-only.",
    );
  });

  it("serializes concurrent first requests so only one thread is created", async () => {
    const calls = stubFetch([
      jsonResponse({ thread_id: "korey-thread-1", message_id: null }, 201),
      jsonResponse(koreyThread()),
      jsonResponse({ message_id: "user-message-1" }, 201),
      completeResponse("First answer"),
      jsonResponse(koreyThread()),
      jsonResponse({ message_id: "user-message-2" }, 201),
      completeResponse("Second answer"),
    ]);
    const host = await loadPlugin();

    const [first, second] = await Promise.all([
      host.harness.callAgentTool("korey_ask", { prompt: "First" }),
      host.harness.callAgentTool("korey_ask", { prompt: "Second" }),
    ]);

    expect(first).toBeTypeOf("string");
    expect(second).toBeTypeOf("string");
    expect(
      calls.filter(
        (call) =>
          call.url === "https://api.korey.ai/api/v1/threads" &&
          call.init?.method === "POST",
      ),
    ).toHaveLength(1);
    expect(calls.filter((call) => call.url.endsWith("/messages"))).toHaveLength(
      2,
    );
  });

  it("reuses an existing private mapping", async () => {
    const calls = stubFetch([
      jsonResponse(koreyThread()),
      jsonResponse({ message_id: "user-message-2" }, 201),
      completeResponse("Second answer"),
    ]);
    const host = await loadPlugin();
    storeMapping(host);

    const result = await host.harness.callAgentTool("korey_ask", {
      prompt: "Refine the acceptance criteria.",
    });

    expect(JSON.parse(String(result))).toMatchObject({
      created: false,
      response: "Second answer",
    });
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.korey.ai/api/v1/threads/korey-thread-1",
      "https://api.korey.ai/api/v1/threads/korey-thread-1/messages",
      "https://api.korey.ai/api/v1/threads/korey-thread-1/messages/user-message-2/response",
    ]);
  });

  it("does not automatically resend an ambiguously dispatched consultation", async () => {
    const calls = stubFetch([
      jsonResponse(koreyThread()),
      new Error("connection reset"),
      messagePage(),
    ]);
    const host = await loadPlugin();
    storeMapping(host);

    const result = await host.harness.callAgentTool("korey_ask", {
      prompt: "Review the launch plan.",
    });

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("unknown dispatch outcome");
    expect(
      calls.filter(
        (call) =>
          call.url.endsWith("/messages") && call.init?.method === "POST",
      ),
    ).toHaveLength(1);
  });
});

describe("Korey Shortcut approval and recovery", () => {
  it.each([303, 307])(
    "keeps HTTP %i dispatch unresolved without following its redirect to a 404",
    async (status) => {
      const fetchImpl = globalThis.fetch;
      const calls: string[] = [];
      await withHttpServer(
        (request) => {
          calls.push(`${request.method} ${request.url}`);
          if (request.url === "/api/v1/me") return identityResponse();
          if (request.url === "/api/v1/threads/korey-thread-1") {
            return jsonResponse(koreyThread());
          }
          if (
            request.method === "POST" &&
            request.url === "/api/v1/threads/korey-thread-1/messages"
          ) {
            return new Response(null, {
              status,
              headers: { location: "/accepted-message" },
            });
          }
          if (
            request.url?.startsWith("/api/v1/threads/korey-thread-1/messages?")
          ) {
            return messagePage();
          }
          return jsonResponse(
            { error: "not found", message: "Response unavailable" },
            404,
          );
        },
        async (baseUrl) => {
          vi.stubGlobal(
            "fetch",
            (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
              const url = new URL(String(input));
              return fetchImpl(`${baseUrl}${url.pathname}${url.search}`, init);
            },
          );
          const host = await loadPlugin();
          storeMapping(host);
          const pending = host.harness.callAgentTool("korey_shortcut_change", {
            action: "create",
            instruction: "Create one approved Story.",
          });
          const interaction = await waitForApproval(host);
          approve(host, interaction);
          const result = await pending;

          expect(result).toMatchObject({ isError: true });
          expect(JSON.stringify(result)).toContain("unknown Shortcut outcome");
          expect(
            listOperations(host.bb.storage.database(), "thread-test", 10)[0],
          ).toMatchObject({
            status: "reconcile-required",
            koreyMessageId: null,
            error: expect.stringContaining(`returned ${status}`),
          });
          expect(calls.filter((call) => call.startsWith("POST "))).toEqual([
            "POST /api/v1/threads/korey-thread-1/messages",
          ]);
          expect(calls.some((call) => call.endsWith("/accepted-message"))).toBe(
            false,
          );
        },
      );
    },
  );

  it.each([202, 408, 499, 500])(
    "keeps unexpected HTTP %i mutation outcomes available for reconciliation",
    async (status) => {
      stubFetch([
        identityResponse(),
        jsonResponse(koreyThread()),
        jsonResponse(koreyThread()),
        jsonResponse({ message: "Outcome unavailable" }, status),
        messagePage(),
      ]);
      const host = await loadPlugin();
      storeMapping(host);
      const pending = host.harness.callAgentTool("korey_shortcut_change", {
        action: "create",
        instruction: "Create one approved Story.",
      });
      const interaction = await waitForApproval(host);
      approve(host, interaction);

      expect(await pending).toMatchObject({ isError: true });
      expect(
        listOperations(host.bb.storage.database(), "thread-test", 10)[0],
      ).toMatchObject({
        status: "reconcile-required",
        koreyMessageId: null,
      });
    },
  );

  it.each([
    ["unchanged", "thread-a", "reconcile-required"],
    ["before-approval", "thread-b", "cancelled"],
    ["during-preparation", "thread-b", "definite-failure"],
  ])(
    "includes and binds unresolved writes after relinking from A to B (%s)",
    async (predecessorChange, operationThreadId, expectedStatus) => {
      const responses: StubbedFetchResult[] = [
        identityResponse(),
        jsonResponse(koreyThread()),
        jsonResponse(koreyThread()),
        new Error("connection reset"),
        messagePage(),
      ];
      const calls = stubFetch(responses);
      const host = await loadPlugin();
      setLinkedMapping(
        host.bb.storage.database(),
        "thread-a",
        "korey-thread-1",
      );
      const input = {
        action: "create",
        instruction: "Create one approved Story.",
      };
      const first = host.harness.callAgentTool("korey_shortcut_change", input, {
        threadId: "thread-a",
      });
      const firstInteraction = await waitForApproval(host);
      approve(host, firstInteraction);
      expect(await first).toMatchObject({ isError: true });

      await host.harness.callAgentTool(
        "korey_unlink_thread",
        {},
        { threadId: "thread-a" },
      );
      responses.push(jsonResponse(koreyThread()));
      const linked = await host.harness.callAgentTool(
        "korey_link_thread",
        { koreyThreadId: "korey-thread-1" },
        { threadId: "thread-b" },
      );
      expect(linked).toBeTypeOf("string");
      responses.push(identityResponse(), jsonResponse(koreyThread()));
      const second = host.harness.callAgentTool(
        "korey_shortcut_change",
        input,
        { threadId: "thread-b" },
      );
      const secondInteraction = await waitForApproval(host);
      const unresolved = secondInteraction.payload.unresolvedOperations;

      const changePredecessor = () => {
        transitionOperation(host.bb.storage.database(), {
          id: firstInteraction.payload.operationId,
          from: "reconcile-required",
          to: "awaiting-response",
          patch: { koreyMessageId: "reconciled-message" },
        });
      };
      if (predecessorChange === "before-approval") {
        changePredecessor();
      }
      responses.push(
        () => {
          if (predecessorChange === "during-preparation") changePredecessor();
          return jsonResponse(koreyThread());
        },
        jsonResponse({ message_id: "write-message-2" }, 201),
        completeResponse("Created SC-999"),
      );
      approve(host, secondInteraction);
      const result = await second;

      expect(unresolved).toEqual([
        {
          operationId: firstInteraction.payload.operationId,
          status: "reconcile-required",
          action: "create",
          storyId: null,
          createdAt: expect.any(Number),
        },
      ]);
      expect(
        typeof result === "string" ? JSON.parse(result) : result,
      ).toMatchObject(
        predecessorChange === "unchanged"
          ? { status: "korey-complete" }
          : { isError: true },
      );
      expect(JSON.stringify(result)).toContain(
        predecessorChange === "unchanged"
          ? "korey-complete"
          : "unresolved operation state changed",
      );
      expect(
        listOperations(host.bb.storage.database(), operationThreadId, 10)[0],
      ).toMatchObject({ status: expectedStatus });
      expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(
        predecessorChange === "unchanged" ? 2 : 1,
      );
    },
  );

  it("makes no write-intended request when the user cancels approval", async () => {
    const calls = stubFetch([identityResponse()]);
    const host = await loadPlugin();
    const pendingResult = host.harness.callAgentTool("korey_shortcut_change", {
      action: "create",
      instruction: "Create a Story from this thread.",
    });
    const interaction = await waitForApproval(host);

    expect(interaction.payload).toMatchObject({
      action: "create",
      storyId: null,
      instruction: "Create a Story from this thread.",
      koreyOrganization: "example",
      destination: { kind: "new-private-thread" },
    });
    expect(calls).toHaveLength(1);
    host.harness.cancelInteraction(interaction.id);
    const result = await pendingResult;

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("approval was cancelled");
    expect(calls).toHaveLength(1);
    expect(
      listOperations(host.bb.storage.database(), "thread-test", 10)[0],
    ).toMatchObject({ status: "cancelled" });
  });

  it("rejects an approval response that is not bound to the request", async () => {
    const calls = stubFetch([identityResponse()]);
    const host = await loadPlugin();
    const pendingResult = host.harness.callAgentTool("korey_shortcut_change", {
      action: "create",
      instruction: "Create a Story from this thread.",
    });
    const interaction = await waitForApproval(host);
    host.harness.submitInteraction(interaction.id, {
      approved: true,
      operationId: interaction.payload.operationId,
      payloadHash: "b".repeat(64),
    });

    const result = await pendingResult;
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("did not match the request");
    expect(calls).toHaveLength(1);
  });

  it("binds approval to the exact destination and rejects a changed link", async () => {
    const calls = stubFetch([identityResponse(), jsonResponse(koreyThread())]);
    const host = await loadPlugin();
    storeMapping(host);
    const pendingResult = host.harness.callAgentTool("korey_shortcut_change", {
      action: "update",
      storyId: "123",
      instruction: "Add the approved acceptance criterion.",
    });
    const interaction = await waitForApproval(host);
    setLinkedMapping(
      host.bb.storage.database(),
      "thread-test",
      "korey-thread-2",
    );
    approve(host, interaction);

    const result = await pendingResult;
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("destination changed");
    expect(calls).toHaveLength(2);
  });

  it("rejects an approval when the Korey conversation revision changed", async () => {
    const calls = stubFetch([
      identityResponse(),
      jsonResponse(koreyThread()),
      jsonResponse(
        koreyThread("korey-thread-1", "ready", "2026-08-21T12:02:00.000Z"),
      ),
    ]);
    const host = await loadPlugin();
    storeMapping(host);
    const pendingResult = host.harness.callAgentTool("korey_shortcut_change", {
      action: "create",
      instruction: "Create the approved Story.",
    });
    const interaction = await waitForApproval(host);
    approve(host, interaction);

    const result = await pendingResult;

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("conversation changed");
    expect(
      calls.filter(
        (call) =>
          call.url.endsWith("/messages") && call.init?.method === "POST",
      ),
    ).toHaveLength(0);
  });

  it("sends one approved create and records immutable operation details", async () => {
    const calls = stubFetch([
      identityResponse(),
      jsonResponse(koreyThread()),
      jsonResponse(koreyThread()),
      jsonResponse({ message_id: "write-message-1" }, 201),
      completeResponse("Created SC-123"),
    ]);
    const host = await loadPlugin();
    storeMapping(host);
    const pendingResult = host.harness.callAgentTool("korey_shortcut_change", {
      action: "create",
      instruction: "Create the approved Story.",
    });
    const interaction = await waitForApproval(host);
    approve(host, interaction);

    const result = await pendingResult;
    expect(result).toBeTypeOf("string");
    expect(JSON.parse(String(result))).toMatchObject({
      operationId: interaction.payload.operationId,
      status: "korey-complete",
      response: "Created SC-123",
    });
    const sentBody = JSON.parse(String(calls[3]?.init?.body));
    expect(sentBody.text).toContain(
      `BB operation reference: ${interaction.payload.operationId}`,
    );
    expect(sentBody.text).toContain("Create exactly one Shortcut Story");
    expect(calls).toHaveLength(5);
  });

  it("claims a new mapping with the approved operation ID", async () => {
    const calls = stubFetch([
      identityResponse(),
      jsonResponse({ thread_id: "korey-thread-1", message_id: null }, 201),
      jsonResponse(koreyThread()),
      jsonResponse({ message_id: "write-message-1" }, 201),
      completeResponse("Created SC-124"),
    ]);
    const host = await loadPlugin();
    const pendingResult = host.harness.callAgentTool("korey_shortcut_change", {
      action: "create",
      instruction: "Create the approved Story in a new conversation.",
    });
    const interaction = await waitForApproval(host);
    approve(host, interaction);

    const result = await pendingResult;

    expect(result).toBeTypeOf("string");
    expect(JSON.parse(String(result))).toMatchObject({
      status: "korey-complete",
      koreyThreadId: "korey-thread-1",
    });
    expect(JSON.parse(String(calls[1]?.init?.body)).name).toContain(
      `[bb-korey:${interaction.payload.operationId}]`,
    );
    expect(getMapping(host.bb.storage.database(), "thread-test")).toMatchObject(
      {
        marker: interaction.payload.operationId,
        generation: 1,
        state: "ready",
      },
    );
  });

  it("releases a new mapping when Korey explicitly rejects its creation", async () => {
    const calls = stubFetch([
      identityResponse(),
      jsonResponse({ message: "forbidden" }, 403),
    ]);
    const host = await loadPlugin();
    const pendingResult = host.harness.callAgentTool("korey_shortcut_change", {
      action: "create",
      instruction: "Create the approved Story in a new conversation.",
    });
    const interaction = await waitForApproval(host);
    approve(host, interaction);

    const result = await pendingResult;

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain(
      "stopped before sending a Shortcut message",
    );
    expect(getMapping(host.bb.storage.database(), "thread-test")).toMatchObject(
      {
        marker: null,
        state: "unlinked",
      },
    );
    expect(calls).toHaveLength(2);
  });

  it("records an ambiguous dispatch and never retries the POST", async () => {
    const calls = stubFetch([
      identityResponse(),
      jsonResponse(koreyThread()),
      jsonResponse(koreyThread()),
      new Error("connection reset"),
      messagePage(),
    ]);
    const host = await loadPlugin();
    storeMapping(host);
    const pendingResult = host.harness.callAgentTool("korey_shortcut_change", {
      action: "create",
      instruction: "Create one approved Story.",
    });
    const interaction = await waitForApproval(host);
    approve(host, interaction);

    const result = await pendingResult;
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("unknown Shortcut outcome");
    expect(
      calls.filter(
        (call) =>
          call.url.endsWith("/messages") && call.init?.method === "POST",
      ),
    ).toHaveLength(1);
    const operation = listOperations(
      host.bb.storage.database(),
      "thread-test",
      10,
    )[0];
    expect(operation).toMatchObject({
      id: interaction.payload.operationId,
      status: "reconcile-required",
      koreyMessageId: null,
    });
  });

  it("reconciles only the exact request and expected attachments", async () => {
    const attachmentId = "7c1d7259-9c10-4e68-98ef-227fe57aad91";
    const responses: StubbedFetchResult[] = [
      identityResponse(),
      jsonResponse(koreyThread()),
      jsonResponse(koreyThread()),
      jsonResponse([{ id: attachmentId, filename: "spec.md" }], 201),
      new Error("connection reset"),
      messagePage(),
    ];
    const calls = stubFetch(responses);
    const host = await loadPlugin();
    storeMapping(host);
    const pendingResult = host.harness.callAgentTool("korey_shortcut_change", {
      action: "create",
      instruction: "Create one approved Story.",
      files: ["spec.md"],
    });
    const interaction = await waitForApproval(host);
    approve(host, interaction);
    await pendingResult;

    const sentBody = JSON.parse(String(calls[4]?.init?.body));
    responses.push(
      messagePage([
        userMessage(
          `Please investigate ${interaction.payload.operationId}. BB operation reference: ${interaction.payload.operationId}`,
          "diagnostic-message",
        ),
      ]),
    );
    const diagnostic = await host.harness.callAgentTool(
      "korey_reconcile_operation",
      { operationId: interaction.payload.operationId },
    );
    expect(JSON.parse(String(diagnostic))).toMatchObject({
      reconciled: false,
      status: "reconcile-required",
    });

    responses.push(messagePage([userMessage(sentBody.text, "missing-file")]));
    const missingFile = await host.harness.callAgentTool(
      "korey_reconcile_operation",
      { operationId: interaction.payload.operationId },
    );
    expect(JSON.parse(String(missingFile))).toMatchObject({
      reconciled: false,
      status: "reconcile-required",
    });

    responses.push(
      messagePage([
        userMessage(sentBody.text, "write-message-1", [attachmentId]),
      ]),
      completeResponse("Created SC-321"),
    );
    const reconciled = await host.harness.callAgentTool(
      "korey_reconcile_operation",
      { operationId: interaction.payload.operationId },
    );

    expect(JSON.parse(String(reconciled))).toMatchObject({
      reconciled: true,
      status: "korey-complete",
      koreyMessageId: "write-message-1",
      response: "Created SC-321",
    });
    expect(
      calls.filter(
        (call) =>
          call.url.endsWith("/messages") && call.init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("records an explicit message rejection as a definite failure", async () => {
    const calls = stubFetch([
      identityResponse(),
      jsonResponse(koreyThread()),
      jsonResponse(koreyThread()),
      jsonResponse({ message: "request rejected" }, 409),
    ]);
    const host = await loadPlugin();
    storeMapping(host);
    const pendingResult = host.harness.callAgentTool("korey_shortcut_change", {
      action: "create",
      instruction: "Create one approved Story.",
    });
    const interaction = await waitForApproval(host);
    approve(host, interaction);

    const result = await pendingResult;

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("rejected operation");
    expect(
      listOperations(host.bb.storage.database(), "thread-test", 10)[0],
    ).toMatchObject({ status: "definite-failure" });
    expect(calls).toHaveLength(4);
  });

  it("discloses an unresolved predecessor in a later approval", async () => {
    const responses: StubbedFetchResult[] = [
      identityResponse(),
      jsonResponse(koreyThread()),
      jsonResponse(koreyThread()),
      new Error("connection reset"),
      messagePage(),
    ];
    const calls = stubFetch(responses);
    const host = await loadPlugin();
    storeMapping(host);
    const firstResult = host.harness.callAgentTool("korey_shortcut_change", {
      action: "create",
      instruction: "Create the first approved Story.",
    });
    const firstInteraction = await waitForApproval(host);
    approve(host, firstInteraction);
    await firstResult;

    responses.push(
      identityResponse(),
      jsonResponse(koreyThread()),
      jsonResponse(koreyThread()),
      jsonResponse({ message_id: "write-message-2" }, 201),
      completeResponse("Created SC-999"),
    );
    const secondResult = host.harness.callAgentTool("korey_shortcut_change", {
      action: "create",
      instruction: "Create the second approved Story.",
    });
    const secondInteraction = await waitForApproval(host);

    expect(secondInteraction.payload.unresolvedOperations).toEqual([
      {
        operationId: firstInteraction.payload.operationId,
        status: "reconcile-required",
        action: "create",
        storyId: null,
        createdAt: expect.any(Number),
      },
    ]);
    approve(host, secondInteraction);
    const result = await secondResult;

    expect(JSON.parse(String(result))).toMatchObject({
      status: "korey-complete",
      response: "Created SC-999",
    });
    expect(
      calls.filter(
        (call) =>
          call.url.endsWith("/messages") && call.init?.method === "POST",
      ),
    ).toHaveLength(2);
  });

  it("resumes polling by recorded message ID without resending", async () => {
    const responses: StubbedFetchResult[] = [
      identityResponse(),
      jsonResponse(koreyThread()),
      jsonResponse(koreyThread()),
      jsonResponse({ message_id: "write-message-1" }, 201),
      jsonResponse(
        { error: "bad request", message: "temporary read failure" },
        400,
      ),
    ];
    const calls = stubFetch(responses);
    const host = await loadPlugin();
    storeMapping(host);
    const pendingResult = host.harness.callAgentTool("korey_shortcut_change", {
      action: "create",
      instruction: "Create one approved Story.",
    });
    const interaction = await waitForApproval(host);
    approve(host, interaction);
    const failed = await pendingResult;

    expect(failed).toMatchObject({ isError: true });
    expect(
      listOperations(host.bb.storage.database(), "thread-test", 10)[0],
    ).toMatchObject({
      status: "awaiting-response",
      koreyMessageId: "write-message-1",
    });
    responses.push(completeResponse("Created SC-456"));
    const resumed = await host.harness.callAgentTool("korey_resume_operation", {
      operationId: interaction.payload.operationId,
    });

    expect(JSON.parse(String(resumed))).toMatchObject({
      status: "korey-complete",
      response: "Created SC-456",
    });
    expect(calls.filter((call) => call.url.endsWith("/messages"))).toHaveLength(
      1,
    );
  });

  it("binds file hashes before upload and supports the CLI approval flow", async () => {
    const attachmentId = "7c1d7259-9c10-4e68-98ef-227fe57aad91";
    const calls = stubFetch([
      identityResponse(),
      jsonResponse(koreyThread()),
      jsonResponse(koreyThread()),
      jsonResponse([{ id: attachmentId, filename: "spec.md" }], 201),
      jsonResponse({ message_id: "write-message-2" }, 201),
      completeResponse("Created SC-789"),
    ]);
    const host = await loadPlugin();
    storeMapping(host);
    const pendingResult = host.harness.runCli([
      "shortcut",
      "create",
      "Create from this file",
      "--file",
      "spec.md",
      "--bb-thread",
      "thread-test",
    ]);
    const interaction = await waitForApproval(host);

    expect(interaction.payload.attachments).toEqual([
      {
        sourcePath: "spec.md",
        filename: "spec.md",
        contentType: "text/markdown",
        size: 17,
        sha256:
          "dc151d18db61e5c1e726bd0a8889b99788054a6061fe2566bef3a744857c19e6",
      },
    ]);
    expect(calls).toHaveLength(2);
    approve(host, interaction);
    const result = await pendingResult;

    expect(result.exitCode).toBe(0);
    expect(calls[3]?.url).toBe(
      "https://api.korey.ai/api/v1/threads/korey-thread-1/attachments",
    );
    const body = calls[3]?.init?.body;
    expect(body).toBeInstanceOf(FormData);
    if (!(body instanceof FormData)) throw new Error("Expected multipart body");
    const uploaded = body.get("attachments[0]");
    expect(uploaded).toBeInstanceOf(File);
    if (!(uploaded instanceof File)) throw new Error("Expected uploaded file");
    expect(await uploaded.text()).toBe("The specification");
  });

  it("rejects duplicate files supplied through different path aliases", async () => {
    stubFetch([identityResponse()]);
    const host = await loadPlugin();

    const result = await host.harness.callAgentTool("korey_shortcut_change", {
      action: "create",
      instruction: "Create from these files.",
      files: ["spec.md", "./spec.md"],
    });

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("Duplicate attachment file");
    expect(host.harness.pendingInteractions).toHaveLength(0);
  });
});

it("registers consultation, approval, and operation recovery surfaces", async () => {
  stubFetch([identityResponse()]);
  const host = await loadPlugin();

  expect(
    host.harness.registrations.agentTools.map((tool) => tool.name),
  ).toEqual([
    "korey_status",
    "korey_list_threads",
    "korey_get_thread",
    "korey_link_thread",
    "korey_unlink_thread",
    "korey_ask",
    "korey_shortcut_change",
    "korey_list_operations",
    "korey_get_operation",
    "korey_resume_operation",
    "korey_reconcile_operation",
  ]);
  expect(host.harness.registrations.cli?.name).toBe("korey");
  await expect(host.harness.runCli(["status"])).resolves.toEqual({
    exitCode: 0,
    stdout: "Authenticated as BB User in example.",
    stderr: "",
  });
});

it("allows token-free local unlinking and operation inspection", async () => {
  const host = await loadPlugin({ settings: {} });
  storeMapping(host);

  await expect(
    host.harness.runCli([
      "operation",
      "list",
      "--bb-thread",
      "thread-test",
      "--json",
    ]),
  ).resolves.toEqual({ exitCode: 0, stdout: "[]", stderr: "" });
  await expect(
    host.harness.runCli(["unlink", "--bb-thread", "thread-test", "--json"]),
  ).resolves.toMatchObject({
    exitCode: 0,
    stdout: expect.stringContaining('"removed": true'),
  });
});
