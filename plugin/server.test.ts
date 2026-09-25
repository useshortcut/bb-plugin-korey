import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHost,
} from "@get-bb/plugin-sdk/testing";
import type { ReadAttachmentResult } from "./attachments.js";
import {
  operationResolutionPayloadSchema,
  shortcutRequestSchema,
} from "./contracts.js";
import {
  beginMappingCreate,
  createOperation,
  getMapping,
  getOperation,
  listUnresolvedOperations,
  reserveMapping,
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
    name: "bb User",
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
    name: "bb: Shape the feature",
    state,
    is_private: true,
    archived: false,
    owner: { id: "korey-user-1", name: "bb User" },
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
    title?: string;
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
            title: options.title ?? "Shape the feature",
            environmentId: "env-test",
          }),
      },
    },
  });
  await koreyPlugin(host.bb);
  hosts.push(host);
  return host;
}

function recordedRequest(host: FakePluginHost) {
  const operation = listOperations(
    host.bb.storage.database(),
    "thread-test",
    1,
  )[0];
  if (!operation) throw new Error("No recorded Shortcut request");
  return shortcutRequestSchema.parse(operation.request);
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
  it.each([
    ["consultation", "sdk failure"],
    ["consultation", "cancellation"],
    ["write", "sdk failure"],
    ["write", "cancellation"],
  ])(
    "releases the mapping after %s preparation ends with %s before dispatch",
    async (mode, failure) => {
      const responses: StubbedFetchResult[] =
        mode === "write" ? [identityResponse()] : [];
      const calls = stubFetch(responses);
      const host = await loadPlugin();
      const db = host.bb.storage.database();
      const controller = new AbortController();
      let preparationState: string | undefined;
      host.harness.inspection.sdk.stub("threads.get", async () => {
        preparationState = getMapping(db, "thread-test")?.state;
        if (failure === "sdk failure")
          throw new Error("Thread lookup unavailable");
        controller.abort();
        return makeThreadResponse({ id: "thread-test", title: "Retry safely" });
      });
      const tool = mode === "write" ? "korey_shortcut_change" : "korey_ask";
      const input =
        mode === "write"
          ? { action: "create", instruction: "Create one Story." }
          : { prompt: "Review the draft." };
      const failed = await host.harness.callAgentTool(tool, input, {
        signal: controller.signal,
      });
      expect(failed).toMatchObject({ isError: true });
      expect(JSON.stringify(failed)).not.toContain("unknown outcome");
      expect(preparationState).toBe("reserved");
      expect(getMapping(db, "thread-test")).toMatchObject({
        state: "unlinked",
        marker: null,
        koreyThreadId: null,
      });
      expect(
        listOperations(db, "thread-test", 20).map(({ status }) => status),
      ).toEqual(mode === "write" ? ["definite-failure"] : []);
      expect(calls.map(({ init }) => init?.method)).toEqual(
        mode === "write" ? ["GET"] : [],
      );

      host.harness.inspection.sdk.stub("threads.get", async () =>
        makeThreadResponse({ id: "thread-test", title: "Retry safely" }),
      );
      responses.push(
        ...(mode === "write" ? [identityResponse()] : []),
        jsonResponse({ thread_id: "korey-thread-1", message_id: null }, 201),
        jsonResponse(koreyThread()),
        jsonResponse({ message_id: "sent" }, 201),
        completeResponse("Done"),
      );
      const retried = await host.harness.callAgentTool(tool, input);
      expect(JSON.parse(String(retried)).response).toContain("Done");
      expect(getMapping(db, "thread-test")?.state).toBe("ready");
      expect(calls.filter(({ init }) => init?.method === "POST")).toHaveLength(
        2,
      );
    },
  );

  it.each(["agent", "cli"])(
    "reports consultation truncation through the %s interface",
    async (mode) => {
      const calls = stubFetch([
        jsonResponse(koreyThread()),
        jsonResponse({ message_id: "sent" }, 201),
        completeResponse(`${"x".repeat(65_535)}🚀 more text`),
      ]);
      const host = await loadPlugin();
      storeMapping(host);
      const result =
        mode === "agent"
          ? await host.harness.callAgentTool("korey_ask", {
              prompt: "Summarize",
              files: [],
            })
          : (
              await host.harness.runCli([
                "ask",
                "Summarize",
                "--bb-thread",
                "thread-test",
                "--json",
              ])
            ).stdout;
      const value = JSON.parse(String(result));
      expect(value).toMatchObject({
        responseTruncated: true,
        appUrl: koreyThread().app_url,
      });
      expect(value.response).toContain(
        "open the Korey conversation to read the full response",
      );
      expect(value.response).not.toContain("\uFFFD");
      expect(Buffer.byteLength(value.response)).toBeLessThan(66_000);
      expect(calls).toHaveLength(3);
    },
  );

  it.each([false, true])(
    "sends consultation attachments once and reconciles ambiguous dispatch (%s)",
    async (reconcile) => {
      const attachmentId = "7c1d7259-9c10-4e68-98ef-227fe57aad91";
      const responses: StubbedFetchResult[] = [
        jsonResponse(koreyThread()),
        jsonResponse([{ id: attachmentId, filename: "spec.md" }], 201),
        reconcile
          ? new Error("connection reset")
          : jsonResponse({ message_id: "sent" }, 201),
      ];
      const calls = stubFetch(responses);
      if (reconcile)
        responses.push(() =>
          messagePage([
            userMessage(JSON.parse(String(calls[2]?.init?.body)).text, "sent", [
              attachmentId,
            ]),
          ]),
        );
      responses.push(completeResponse("Reviewed the file"));
      const host = await loadPlugin();
      storeMapping(host);
      const result = await host.harness.callAgentTool("korey_ask", {
        prompt: "Review this specification",
        files: ["spec.md"],
      });
      expect(JSON.parse(String(result))).toMatchObject({
        response: "Reviewed the file",
        responseTruncated: false,
      });
      expect(calls[1]?.init?.body).toBeInstanceOf(FormData);
      expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({
        text: expect.stringContaining("This request is consultation-only."),
        attachment_ids: [attachmentId],
      });
      expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(
        2,
      );
    },
  );

  it.each([false, true])(
    "reconciles mapping markers across pages with owned-list fallback (%s)",
    async (fallback) => {
      const marker = "11111111-1111-4111-8111-111111111111";
      const matched = {
        ...koreyThread(),
        name: `bb: Recovered [bb-korey:${marker}]`,
      };
      const page = (data: unknown[], after: string | null, more: boolean) =>
        jsonResponse({
          data,
          first_id: after,
          last_id: after,
          has_more: more,
          limit: 50,
        });
      const calls = stubFetch([
        ...(fallback ? [page([], null, false)] : []),
        page([koreyThread("unrelated")], "unrelated", true),
        page([matched], matched.id, false),
        jsonResponse(matched),
        jsonResponse({ message_id: "sent" }, 201),
        completeResponse(),
      ]);
      const host = await loadPlugin();
      const mapping = reserveMapping(
        host.bb.storage.database(),
        "thread-test",
        marker,
      );
      beginMappingCreate(
        host.bb.storage.database(),
        "thread-test",
        mapping.generation,
      );
      const result = await host.harness.callAgentTool("korey_ask", {
        prompt: "Continue",
      });
      expect(result).toBeTypeOf("string");
      expect(
        getMapping(host.bb.storage.database(), "thread-test"),
      ).toMatchObject({ state: "ready", koreyThreadId: matched.id });
      const pages = calls.filter(
        (call) => new URL(call.url).pathname === "/api/v1/threads",
      );
      expect(pages.map((call) => call.init?.method)).toEqual(
        Array(fallback ? 3 : 2).fill("GET"),
      );
      expect(new URL(pages.at(-1)!.url).searchParams.get("after")).toBe(
        "unrelated",
      );
      expect(new URL(pages.at(-1)!.url).searchParams.has("q")).toBe(!fallback);
    },
  );

  it.each(["duplicate", "stalled", "limit"])(
    "keeps mapping recovery unresolved for %s results",
    async (problem) => {
      const marker = "11111111-1111-4111-8111-111111111111";
      const matches = ["one", "two"].map((id) => ({
        ...koreyThread(id),
        name: `bb: [bb-korey:${marker}]`,
      }));
      const responses =
        problem === "duplicate"
          ? [
              jsonResponse({
                data: matches,
                first_id: "one",
                last_id: "two",
                has_more: false,
                limit: 50,
              }),
            ]
          : Array.from({ length: problem === "stalled" ? 2 : 20 }, (_, index) =>
              jsonResponse({
                data: [],
                first_id: null,
                last_id: problem === "stalled" ? "same" : String(index),
                has_more: true,
                limit: 50,
              }),
            );
      const calls = stubFetch(responses);
      const host = await loadPlugin();
      const mapping = reserveMapping(
        host.bb.storage.database(),
        "thread-test",
        marker,
      );
      beginMappingCreate(
        host.bb.storage.database(),
        "thread-test",
        mapping.generation,
      );
      const result = await host.harness.callAgentTool("korey_ask", {
        prompt: "Continue",
      });
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain(
        problem === "duplicate"
          ? "Multiple Korey threads"
          : problem === "stalled"
            ? "pagination did not advance"
            : "exceeded 20 pages",
      );
      expect(calls.every((call) => call.init?.method === "GET")).toBe(true);
      expect(
        getMapping(host.bb.storage.database(), "thread-test")?.koreyThreadId,
      ).toBeNull();
    },
  );

  it("preserves Unicode when truncating a marked conversation name", async () => {
    const calls = stubFetch([
      jsonResponse({ thread_id: "korey-thread-1", message_id: null }, 201),
      jsonResponse(koreyThread()),
      jsonResponse({ message_id: "sent" }, 201),
      completeResponse(),
    ]);
    const host = await loadPlugin({ title: `${"a".repeat(67)}🚀 finish` });
    await host.harness.callAgentTool("korey_ask", { prompt: "Hello" });
    const name: string = JSON.parse(String(calls[0]?.init?.body)).name;
    expect(Buffer.from(name, "utf8").toString("utf8")).toBe(name);
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name).toMatch(/\[bb-korey:[a-f0-9-]+\]$/u);
  });

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
      /^bb: Shape the feature \[bb-korey:[a-f0-9-]+\]$/u,
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

describe("Korey Shortcut requests and recovery", () => {
  it.each(["same-thread", "relinked", "unlinked"])(
    "blocks a new write until an uncertain %s predecessor is resolved",
    async (scenario) => {
      const calls = stubFetch([
        identityResponse(),
        jsonResponse(koreyThread()),
        jsonResponse(koreyThread()),
        new Error("connection reset"),
        messagePage(),
      ]);
      const host = await loadPlugin();
      storeMapping(host);
      const input = { action: "create", instruction: "Create one Story." };
      const first = await host.harness.callAgentTool(
        "korey_shortcut_change",
        input,
      );
      expect(first).toMatchObject({ isError: true });
      const original = recordedRequest(host);
      if (scenario !== "same-thread")
        await host.harness.callAgentTool("korey_unlink_thread", {});
      const target = scenario === "relinked" ? "thread-other" : "thread-test";
      if (scenario === "relinked")
        setLinkedMapping(host.bb.storage.database(), target, "korey-thread-1");
      const result = await host.harness.callAgentTool(
        "korey_shortcut_change",
        input,
        { threadId: target },
      );
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain(original.operationId);
      expect(JSON.stringify(result)).toContain("This request was not sent");
      expect(JSON.stringify(result)).toContain(
        `bb korey operation show ${original.operationId} --bb-thread thread-test`,
      );
      expect(calls).toHaveLength(5);
      expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(
        1,
      );
      expect(host.harness.pendingInteractions).toHaveLength(0);
      expect(
        listOperations(host.bb.storage.database(), target, 20),
      ).toHaveLength(scenario === "relinked" ? 0 : 1);
    },
  );

  it.each(["resume", "reconcile", "resolve"] as const)(
    "allows %s from a relinked thread without escaping or duplicating the operation",
    async (action) => {
      const responses: StubbedFetchResult[] = [
        identityResponse(),
        jsonResponse(koreyThread()),
        jsonResponse(koreyThread()),
        ...(action === "resume"
          ? [
              jsonResponse({ message_id: "sent" }, 201),
              jsonResponse({ message: "Response unavailable" }, 404),
            ]
          : [new Error("connection reset"), messagePage()]),
      ];
      const calls = stubFetch(responses);
      const host = await loadPlugin();
      storeMapping(host);
      await host.harness.callAgentTool("korey_shortcut_change", {
        action: "create",
        instruction: "Create one Story.",
      });
      const db = host.bb.storage.database();
      const request = recordedRequest(host);
      const original = getOperation(db, request.operationId)!;
      const context = { threadId: "thread-other" };

      await host.harness.callAgentTool("korey_unlink_thread", {});
      responses.push(jsonResponse(koreyThread()));
      await host.harness.callAgentTool(
        "korey_link_thread",
        { koreyThreadId: "korey-thread-1" },
        context,
      );
      expect(
        JSON.parse(
          String(
            await host.harness.callAgentTool(
              "korey_get_operation",
              { operationId: original.id },
              context,
            ),
          ),
        ),
      ).toMatchObject({ operationId: original.id, status: original.status });
      expect(
        JSON.parse(
          String(
            await host.harness.callAgentTool(
              "korey_list_operations",
              {},
              context,
            ),
          ),
        ),
      ).toEqual([expect.objectContaining({ operationId: original.id })]);
      const listed = await host.harness.runCli([
        "operation",
        "list",
        "--bb-thread",
        context.threadId,
        "--json",
      ]);
      expect(JSON.parse(listed.stdout)).toEqual([
        expect.objectContaining({ operationId: original.id }),
      ]);

      for (const tool of [
        "korey_get_operation",
        "korey_resume_operation",
        "korey_reconcile_operation",
      ]) {
        const denied = await host.harness.callAgentTool(
          tool,
          { operationId: original.id },
          { threadId: "unrelated-thread" },
        );
        expect(denied).toMatchObject({ isError: true });
        expect(JSON.stringify(denied)).toContain("Unknown Korey operation");
      }
      for (const [tool, input] of [
        ["korey_unlink_thread", {}],
        ["korey_link_thread", { koreyThreadId: "korey-thread-2" }],
      ] as const) {
        const blocked = await host.harness.callAgentTool(tool, input, context);
        expect(blocked).toMatchObject({ isError: true });
        expect(JSON.stringify(blocked)).toContain(original.id);
        expect(JSON.stringify(blocked)).toContain("before changing its link");
      }
      expect(getMapping(db, context.threadId)?.koreyThreadId).toBe(
        "korey-thread-1",
      );
      expect(calls).toHaveLength(6);

      let resolvedExitCode: number | undefined;
      let recoveredStatuses: string[] = [];
      if (action === "resolve") {
        const resolving = host.harness.runCli([
          "operation",
          "resolve",
          original.id,
          "Verified the requested Story exists.",
          "--bb-thread",
          context.threadId,
          "--json",
        ]);
        const interaction = await vi.waitFor(() => {
          const pending = host.harness.pendingInteractions[0];
          if (pending === undefined)
            throw new Error("Waiting for resolution form");
          return pending;
        });
        const payload = operationResolutionPayloadSchema.parse(
          interaction.payload,
        );
        host.harness.submitInteraction(interaction.id, {
          confirmed: true,
          operationId: original.id,
          resolutionHash: payload.resolutionHash,
        });
        resolvedExitCode = (await resolving).exitCode;
      } else {
        if (action === "reconcile") {
          responses.push(
            messagePage([userMessage(original.dispatchedText!, "sent")]),
          );
        }
        responses.push(completeResponse("Created SC-123"));
        const tool =
          action === "resume"
            ? "korey_resume_operation"
            : "korey_reconcile_operation";
        const results = await Promise.all(
          [context.threadId, "thread-test"].map((threadId) =>
            host.harness.callAgentTool(
              tool,
              { operationId: original.id },
              { threadId },
            ),
          ),
        );
        recoveredStatuses = results.map(
          (result) => JSON.parse(String(result)).status,
        );
      }
      expect(resolvedExitCode).toBe(action === "resolve" ? 0 : undefined);
      expect(recoveredStatuses).toEqual(
        action === "resolve" ? [] : ["korey-complete", "korey-complete"],
      );
      expect(getOperation(db, original.id)?.status).toBe(
        action === "resolve" ? "manually-resolved" : "korey-complete",
      );
      expect(
        listUnresolvedOperations(db, context.threadId, "korey-thread-1"),
      ).toEqual([]);
      expect(calls.filter(({ init }) => init?.method === "POST")).toHaveLength(
        1,
      );

      const unlinked = await host.harness.callAgentTool(
        "korey_unlink_thread",
        {},
        context,
      );
      expect(JSON.parse(String(unlinked))).toMatchObject({ removed: true });
      const denied = await host.harness.callAgentTool(
        "korey_get_operation",
        { operationId: original.id },
        context,
      );
      expect(denied).toMatchObject({ isError: true });
      expect(host.harness.pendingInteractions).toHaveLength(0);
    },
  );

  it("rechecks unresolved operations after preparing attachments", async () => {
    const host = await loadPlugin();
    storeMapping(host);
    const db = host.bb.storage.database();
    const predecessorId = "korey-11111111-1111-4111-8111-111111111111";
    createOperation(db, {
      operationId: predecessorId,
      requestHash: "a".repeat(64),
      bbThreadId: "previous-thread",
      action: "create",
      storyId: null,
      instruction: "Create the previous Story.",
      koreyOrganization: "example",
      attachments: [],
      destination: {
        kind: "linked-private-thread",
        koreyThreadId: "korey-thread-1",
        koreyThreadRevision: "revision",
        mappingGeneration: 1,
      },
    });
    transitionOperation(db, {
      id: predecessorId,
      from: "requested",
      to: "message-dispatching",
      patch: { koreyThreadId: "korey-thread-1" },
    });
    const calls = stubFetch([
      identityResponse(),
      jsonResponse(koreyThread()),
      jsonResponse(koreyThread()),
      () => {
        transitionOperation(db, {
          id: predecessorId,
          from: "message-dispatching",
          to: "reconcile-required",
        });
        return jsonResponse(
          [{ id: "7c1d7259-9c10-4e68-98ef-227fe57aad91", filename: "spec.md" }],
          201,
        );
      },
    ]);
    const result = await host.harness.callAgentTool("korey_shortcut_change", {
      action: "create",
      instruction: "Create a Story.",
      files: ["spec.md"],
    });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain(predecessorId);
    expect(listOperations(db, "thread-test", 1)[0]).toMatchObject({
      status: "definite-failure",
      koreyMessageId: null,
    });
    expect(
      calls
        .filter((call) => call.init?.method === "POST")
        .map((call) => call.url),
    ).toEqual([
      "https://api.korey.ai/api/v1/threads/korey-thread-1/attachments",
    ]);
  });

  it("serializes simultaneous requested writes and claims only one first-use mapping", async () => {
    const calls = stubFetch([
      identityResponse(),
      jsonResponse({ thread_id: "korey-thread-1", message_id: null }, 201),
      jsonResponse(koreyThread()),
      jsonResponse({ message_id: "first" }, 201),
      completeResponse("Created SC-1"),
      identityResponse(),
      jsonResponse(koreyThread()),
      jsonResponse(koreyThread()),
      jsonResponse({ message_id: "second" }, 201),
      completeResponse("Created SC-2"),
    ]);
    const host = await loadPlugin();
    const results = await Promise.all(
      ["First Story", "Second Story"].map((instruction) =>
        host.harness.callAgentTool("korey_shortcut_change", {
          action: "create",
          instruction,
        }),
      ),
    );
    expect(results.map((result) => JSON.parse(String(result)).status)).toEqual([
      "korey-complete",
      "korey-complete",
    ]);
    expect(
      calls.filter(
        (call) => call.init?.method === "POST" && call.url.endsWith("/threads"),
      ),
    ).toHaveLength(1);
    expect(
      calls.filter(
        (call) =>
          call.init?.method === "POST" && call.url.endsWith("/messages"),
      ),
    ).toHaveLength(2);
    expect(host.harness.pendingInteractions).toHaveLength(0);
  });

  it("stops when the destination changes during preparation", async () => {
    const host = await loadPlugin();
    storeMapping(host);
    const calls = stubFetch([
      identityResponse(),
      () => {
        setLinkedMapping(
          host.bb.storage.database(),
          "thread-test",
          "korey-thread-2",
        );
        return jsonResponse(koreyThread());
      },
    ]);
    const result = await host.harness.callAgentTool("korey_shortcut_change", {
      action: "create",
      instruction: "Create a Story.",
    });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("destination changed");
    expect(calls.map((call) => call.init?.method)).toEqual(["GET", "GET"]);
    expect(
      listOperations(host.bb.storage.database(), "thread-test", 1),
    ).toEqual([]);
  });

  it("does not start a cancelled request", async () => {
    const host = await loadPlugin();
    const calls = stubFetch([]);
    const signal = AbortSignal.abort();
    const result = await host.harness.callAgentTool(
      "korey_shortcut_change",
      { action: "create", instruction: "Create a Story." },
      { signal },
    );
    expect(result).toMatchObject({ isError: true });
    expect(calls).toEqual([]);
    expect(
      listOperations(host.bb.storage.database(), "thread-test", 1),
    ).toEqual([]);
  });

  it.each(["dispatch", "polling"])(
    "preserves recoverable state when cancelled during %s",
    async (stage) => {
      const controller = new AbortController();
      const cancel = () => {
        controller.abort();
        throw new Error("Cancelled in flight");
      };
      const responses: StubbedFetchResult[] = [
        identityResponse(),
        jsonResponse(koreyThread()),
        jsonResponse(koreyThread()),
        ...(stage === "dispatch"
          ? [cancel]
          : [jsonResponse({ message_id: "sent" }, 201), cancel]),
      ];
      const calls = stubFetch(responses);
      const host = await loadPlugin();
      storeMapping(host);
      const pending = host.harness.callAgentTool(
        "korey_shortcut_change",
        { action: "create", instruction: "Create once" },
        { signal: controller.signal },
      );
      const changeResult = await pending;
      const request = recordedRequest(host);
      expect(changeResult).toMatchObject({ isError: true });
      expect(
        getOperation(host.bb.storage.database(), request.operationId),
      ).toMatchObject({
        status:
          stage === "dispatch" ? "reconcile-required" : "awaiting-response",
      });
      if (stage === "polling") {
        responses.push(completeResponse("Created SC-123"));
        await host.harness.callAgentTool("korey_resume_operation", {
          operationId: request.operationId,
        });
      }
      expect(
        getOperation(host.bb.storage.database(), request.operationId)?.status,
      ).toBe(stage === "dispatch" ? "reconcile-required" : "korey-complete");
      expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(
        1,
      );
    },
  );

  it("normalizes an update Story ID and sends the requested update without confirmation", async () => {
    const calls = stubFetch([
      identityResponse(),
      jsonResponse(koreyThread()),
      jsonResponse(koreyThread()),
      jsonResponse({ message_id: "sent" }, 201),
      completeResponse("Updated SC-123"),
    ]);
    const host = await loadPlugin();
    storeMapping(host);
    const pending = host.harness.callAgentTool("korey_shortcut_change", {
      action: "update",
      storyId: " SC-123 ",
      instruction: " Add the reviewed criterion. ",
      files: [],
    });
    const changeResult = await pending;
    const request = recordedRequest(host);
    expect(request).toMatchObject({
      action: "update",
      storyId: "sc-123",
      instruction: "Add the reviewed criterion.",
      attachments: [],
    });
    expect(JSON.parse(String(changeResult))).toMatchObject({
      status: "korey-complete",
    });
    const text: string = JSON.parse(String(calls[3]?.init?.body)).text;
    expect(text).toContain("Update Shortcut Story sc-123.");
    expect(text).toContain("Preserve unrelated fields.");
    expect(text).toContain("Add the reviewed criterion.");
    expect(text).not.toContain("Create exactly one Shortcut Story");
  });

  it.each(["active", "waiting", "error", "interrupted"])(
    "rejects a %s conversation before dispatch",
    async (state) => {
      const calls = stubFetch([
        identityResponse(),
        jsonResponse(koreyThread("korey-thread-1", state)),
      ]);
      const host = await loadPlugin();
      storeMapping(host);
      const result = await host.harness.callAgentTool("korey_shortcut_change", {
        action: "create",
        instruction: "Create a Story",
      });
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toContain("before sending the request");
      expect(host.harness.pendingInteractions).toHaveLength(0);
      expect(
        listOperations(host.bb.storage.database(), "thread-test", 20),
      ).toEqual([]);
      expect(calls.map((call) => call.init?.method)).toEqual(["GET", "GET"]);
    },
  );

  it.each(["confirm", "cancel", "tamper", "changed"] as const)(
    "requires a bound human confirmation for manual resolution (%s)",
    async (outcome) => {
      const calls = stubFetch([
        identityResponse(),
        jsonResponse(koreyThread()),
        jsonResponse(koreyThread()),
        new Error("connection reset"),
        messagePage(),
      ]);
      const host = await loadPlugin();
      storeMapping(host);
      const pending = host.harness.callAgentTool("korey_shortcut_change", {
        action: "create",
        instruction: "Create one Story.",
      });
      await pending;
      const request = recordedRequest(host);

      const db = host.bb.storage.database();
      const before = getOperation(db, request.operationId)!;
      expect(before.status).toBe("reconcile-required");
      const resolving = host.harness.runCli([
        "operation",
        "resolve",
        before.id,
        "Inspected Korey and Shortcut; SC-123 contains the requested change.",
        "--bb-thread",
        "thread-test",
        "--json",
      ]);
      const interaction = await vi.waitFor(() => {
        const current = host.harness.pendingInteractions[0];
        expect(current).toBeDefined();
        return current!;
      });
      const payload = operationResolutionPayloadSchema.parse(
        interaction.payload,
      );
      expect(getOperation(db, before.id)).toEqual(before);
      if (outcome === "cancel") {
        host.harness.cancelInteraction(interaction.id);
      } else {
        if (outcome === "changed")
          transitionOperation(db, {
            id: before.id,
            from: "reconcile-required",
            to: "awaiting-response",
            patch: { koreyMessageId: "found" },
          });
        host.harness.submitInteraction(interaction.id, {
          confirmed: true,
          operationId: before.id,
          resolutionHash:
            outcome === "tamper" ? "0".repeat(64) : payload.resolutionHash,
        });
      }
      const result = await resolving;
      expect(result.exitCode).toBe(outcome === "confirm" ? 0 : 1);
      const timestamp = expect.any(Number);
      expect(getOperation(db, before.id)).toMatchObject({
        status:
          outcome === "confirm"
            ? "manually-resolved"
            : outcome === "changed"
              ? "awaiting-response"
              : "reconcile-required",
        resolutionNote: outcome === "confirm" ? payload.note : null,
        completedAt: outcome === "confirm" ? timestamp : null,
        error: before.error,
        request: before.request,
        requestHash: before.requestHash,
      });
      expect(
        listUnresolvedOperations(db, "thread-test", "korey-thread-1"),
      ).toHaveLength(outcome === "confirm" ? 0 : 1);
      let replayExitCode: number | undefined;
      if (outcome === "confirm") {
        const replay = await host.harness.runCli([
          "operation",
          "resolve",
          before.id,
          "Resolve again",
          "--bb-thread",
          "thread-test",
        ]);
        replayExitCode = replay.exitCode;
      }
      expect(replayExitCode).toBe(outcome === "confirm" ? 1 : undefined);
      expect(host.harness.pendingInteractions).toHaveLength(0);
      expect(calls).toHaveLength(5);
    },
  );

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

  it.each([202, 400, 408, 422, 499, 500])(
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
      const changeResult = await pending;

      expect(changeResult).toMatchObject({ isError: true });
      expect(
        listOperations(host.bb.storage.database(), "thread-test", 10)[0],
      ).toMatchObject({
        status: "reconcile-required",
        koreyMessageId: null,
      });
    },
  );

  it("stops before dispatch when the Korey conversation revision changes", async () => {
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

  it.each([false, true])(
    "completes one requested create without confirmation, including additive API changes (%s)",
    async (additive) => {
      const calls = stubFetch([
        identityResponse(),
        jsonResponse(koreyThread()),
        jsonResponse(koreyThread()),
        jsonResponse({ message_id: "write-message-1" }, 201),
        additive
          ? jsonResponse({
              status: "complete",
              extra: true,
              messages: [
                {
                  ...assistantMessage("Created SC-123"),
                  extra: true,
                  contents: [
                    { type: "text", text: "Created SC-123", extra: true },
                    { type: "connector_result" },
                  ],
                },
              ],
            })
          : completeResponse("Created SC-123"),
      ]);
      const host = await loadPlugin();
      storeMapping(host);
      const pendingResult = host.harness.callAgentTool(
        "korey_shortcut_change",
        {
          action: "create",
          instruction: "Create the approved Story.",
        },
      );
      const result = await pendingResult;
      const request = recordedRequest(host);

      expect(result).toBeTypeOf("string");
      expect(JSON.parse(String(result))).toMatchObject({
        operationId: request.operationId,
        status: "korey-complete",
        response: expect.stringContaining("Created SC-123"),
        approvedAt: null,
        requestVersion: 2,
      });
      expect(host.harness.pendingInteractions).toHaveLength(0);
      const sentBody = JSON.parse(String(calls[3]?.init?.body));
      expect(sentBody.text).toContain(
        `bb operation reference: ${request.operationId}`,
      );
      expect(sentBody.text).toContain("Create exactly one Shortcut Story");
      expect(sentBody.text).toContain(
        "The user requested this Shortcut change from bb.",
      );
      expect(sentBody.text).not.toContain("confirmation UI");
      expect(calls).toHaveLength(5);
    },
  );

  it("claims a new mapping with the recorded operation ID", async () => {
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
    const result = await pendingResult;
    const request = recordedRequest(host);

    expect(result).toBeTypeOf("string");
    expect(JSON.parse(String(result))).toMatchObject({
      status: "korey-complete",
      koreyThreadId: "korey-thread-1",
    });
    expect(JSON.parse(String(calls[1]?.init?.body)).name).toContain(
      `[bb-korey:${request.operationId}]`,
    );
    expect(getMapping(host.bb.storage.database(), "thread-test")).toMatchObject(
      {
        marker: request.operationId,
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
    const result = await pendingResult;
    const request = recordedRequest(host);

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
      id: request.operationId,
      status: "reconcile-required",
      koreyMessageId: null,
    });
  });

  it.each(["legacy", "recorded", "recorded-uppercase"])(
    "reconciles only exact text and attachments from %s journals",
    async (journal) => {
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
      const pendingResult = host.harness.callAgentTool(
        "korey_shortcut_change",
        {
          action: "create",
          instruction: "Create one approved Story.",
          files: ["spec.md"],
        },
      );
      await pendingResult;
      const request = recordedRequest(host);

      const sentBody = JSON.parse(String(calls[4]?.init?.body));
      if (journal !== "recorded") {
        const historicalProductName = "bb".toUpperCase();
        sentBody.text = sentBody.text
          .replace(
            "bb operation reference:",
            `${historicalProductName} operation reference:`,
          )
          .replace(
            "The user requested this Shortcut change from bb.",
            journal === "legacy"
              ? "The user approved this external write through bb's confirmation UI."
              : `The user requested this Shortcut change from ${historicalProductName}.`,
          );
      }
      // Reconciliation uses the recorded bytes even if a later approval schema
      // has changed. Historical records must remain inspectable as well.
      host.bb.storage
        .database()
        .prepare(
          "UPDATE korey_operations SET request_json = ?, request_version = ?, dispatched_text = ? WHERE id = ?",
        )
        .run(
          JSON.stringify(
            journal === "legacy"
              ? { ...request, oldApprovalField: true }
              : { action: "future-action" },
          ),
          journal === "legacy" ? 1 : 2,
          journal === "legacy" ? null : sentBody.text,
          request.operationId,
        );
      const history = await host.harness.callAgentTool(
        "korey_list_operations",
        {},
      );
      expect(JSON.parse(String(history))).toEqual([
        expect.objectContaining({
          operationId: request.operationId,
          action: journal === "legacy" ? "create" : "unknown",
          requestVersion: journal === "legacy" ? 1 : 2,
        }),
      ]);
      responses.push(
        messagePage([
          userMessage(
            `Please investigate ${request.operationId}. bb operation reference: ${request.operationId}`,
            "diagnostic-message",
          ),
        ]),
      );
      const diagnostic = await host.harness.callAgentTool(
        "korey_reconcile_operation",
        { operationId: request.operationId },
      );
      expect(JSON.parse(String(diagnostic))).toMatchObject({
        reconciled: false,
        status: "reconcile-required",
      });

      responses.push(messagePage([userMessage(sentBody.text, "missing-file")]));
      const missingFile = await host.harness.callAgentTool(
        "korey_reconcile_operation",
        { operationId: request.operationId },
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
        { operationId: request.operationId },
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
    },
  );

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
    const result = await pendingResult;

    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("rejected operation");
    expect(
      listOperations(host.bb.storage.database(), "thread-test", 10)[0],
    ).toMatchObject({ status: "definite-failure" });
    expect(calls).toHaveLength(4);
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
    const failed = await pendingResult;
    const request = recordedRequest(host);

    expect(failed).toMatchObject({ isError: true });
    expect(
      listOperations(host.bb.storage.database(), "thread-test", 10)[0],
    ).toMatchObject({
      status: "awaiting-response",
      koreyMessageId: "write-message-1",
    });
    responses.push(completeResponse("Created SC-456"));
    const resumed = await host.harness.callAgentTool("korey_resume_operation", {
      operationId: request.operationId,
    });

    expect(JSON.parse(String(resumed))).toMatchObject({
      status: "korey-complete",
      response: "Created SC-456",
    });
    expect(calls.filter((call) => call.url.endsWith("/messages"))).toHaveLength(
      1,
    );
  });

  it("binds file hashes before upload and supports direct CLI requests", async () => {
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
    const result = await pendingResult;
    const request = recordedRequest(host);

    expect(request.attachments).toEqual([
      {
        sourcePath: "spec.md",
        filename: "spec.md",
        contentType: "text/markdown",
        size: 17,
        sha256:
          "dc151d18db61e5c1e726bd0a8889b99788054a6061fe2566bef3a744857c19e6",
      },
    ]);

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

it("registers consultation, direct writes, and operation recovery surfaces", async () => {
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
    stdout: "Authenticated as bb User in example.",
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
