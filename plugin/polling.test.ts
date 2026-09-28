import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import koreyPlugin from "./server.js";
import {
  KoreyClient,
  KoreyResponsePendingError,
  formatKoreyMessages,
} from "./korey-client.js";
import {
  createOperation,
  listOperations,
  setLinkedMapping,
  transitionOperation,
} from "./data.js";

const threadId = "mock-thread";
const messageId = "accepted-consultation";
const hosts: Awaited<ReturnType<typeof loadHost>>[] = [];
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const thread = (state = "ready") => ({
  id: threadId,
  name: "Mock investigation",
  state,
  is_private: true,
  archived: false,
  owner: { id: "mock-user", name: "Test" },
  created_at: "2026-09-28T13:53:32Z",
  updated_at: "2026-09-28T13:53:32Z",
  app_url: `https://korey.invalid/threads/${threadId}`,
});
const message = (id: string, text: string, role = "assistant") => ({
  id,
  thread_id: threadId,
  role,
  contents: [{ type: "text", text }],
  created_at: "2026-09-28T13:55:39Z",
  app_url: `https://korey.invalid/threads/${threadId}/messages/${id}`,
});
const complete = (text = "The eventual answer") =>
  json({ status: "complete", messages: [message("answer", text)] });

async function loadHost() {
  const host = createFakePluginHost({
    pluginId: "korey",
    settings: { apiToken: "mock-only-token" },
    agentSkillIds: ["korey"],
  });
  await koreyPlugin(host.bb);
  setLinkedMapping(host.bb.storage.database(), "thread-test", threadId);
  return host;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

describe("Korey response recovery", () => {
  it.each(["error", "interrupted"])(
    "does not mistake a %s thread for completion",
    async (state) => {
      const client = new KoreyClient({
        token: "mock-only-token",
        fetch: async (input) =>
          String(input).endsWith("/response")
            ? complete("Intermediate response")
            : json(thread(state)),
      });
      await expect(client.waitForResponse(threadId, messageId)).rejects.toThrow(
        `Korey processing ${state}`,
      );
    },
  );

  it("fetches again when the thread becomes ready after an intermediate response", async () => {
    let reads = 0;
    const client = new KoreyClient({
      token: "mock-only-token",
      fetch: async (input) =>
        String(input).endsWith("/response")
          ? complete(++reads === 1 ? "Intermediate response" : "Final response")
          : json(thread()),
    });
    expect(
      formatKoreyMessages(await client.waitForResponse(threadId, messageId)),
    ).toBe("Final response");
  });

  it("bounds a pending response even while the thread is still ready before queue pickup", async () => {
    const client = new KoreyClient({
      token: "mock-only-token",
      responseTimeoutMs: 100,
      fetch: async (input) =>
        String(input).endsWith("/response")
          ? json({ error: "not-found", message: "No response yet" }, 404)
          : json(thread()),
    });
    await expect(
      client.waitForResponse(threadId, messageId),
    ).rejects.toBeInstanceOf(KoreyResponsePendingError);
  });

  it("cancels pending reads without dispatching any messages", async () => {
    const controller = new AbortController();
    const requests: string[] = [];
    const client = new KoreyClient({
      token: "mock-only-token",
      fetch: async (input, init) => {
        requests.push(`${init?.method} ${String(input)}`);
        controller.abort();
        return json({ error: "not-found", message: "No response yet" }, 404);
      },
    });
    await expect(
      client.waitForResponse(threadId, messageId, controller.signal),
    ).rejects.toThrow("cancelled");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain("GET");
  });

  it("refreshes an operation closed by the old polling logic without replaying it", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      return String(input).endsWith("/response")
        ? complete("Final verification")
        : json(thread());
    });
    const host = await loadHost();
    hosts.push(host);
    const db = host.bb.storage.database();
    const operation = createOperation(db, {
      operationId: "korey-00000000-0000-4000-8000-000000000001",
      requestHash: "a".repeat(64),
      bbThreadId: "thread-test",
      action: "change",
      storyId: null,
      instruction: "An already dispatched change",
      koreyOrganization: "mock",
      attachments: [],
      destination: {
        kind: "linked-private-thread",
        koreyThreadId: threadId,
        koreyThreadRevision: "revision",
        mappingGeneration: 1,
      },
    });
    transitionOperation(db, {
      id: operation.id,
      from: "requested",
      to: "korey-complete",
      patch: {
        koreyThreadId: threadId,
        koreyMessageId: messageId,
        responseText: "Proceeding with the update",
        completedAt: 1,
      },
    });
    const result = await host.harness.callAgentTool("korey_resume_operation", {
      operationId: operation.id,
    });
    expect(JSON.parse(String(result))).toMatchObject({
      status: "korey-complete",
      response: "Final verification",
    });
    expect(requests).toHaveLength(3);
    expect(requests.every((request) => request.startsWith("GET"))).toBe(true);
  });

  it("returns a delayed answer after 404 No response yet without dispatching twice", async () => {
    let posts = 0;
    let responseReads = 0;
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (init?.method === "POST" && path.endsWith("/messages")) {
        posts += 1;
        return json({ message_id: messageId }, 201);
      }
      if (path.endsWith("/response")) {
        responseReads += 1;
        if (responseReads === 1)
          return json({ error: "not-found", message: "No response yet" }, 404);
        if (responseReads === 2) return json({ status: "processing" }, 202);
        return complete();
      }
      if (path.endsWith(`/threads/${threadId}`)) return json(thread());
      throw new Error(`Unexpected mocked request: ${path}`);
    });
    const host = await loadHost();
    hosts.push(host);
    const result = await host.harness.callAgentTool("korey_ask", {
      mode: "consult",
      prompt: "Research this question",
    });
    expect(
      requests.filter((request) => request.startsWith("POST")),
    ).toHaveLength(1);
    expect(posts).toBe(1);
    expect(result).not.toMatchObject({ isError: true });
    expect(JSON.parse(String(result)).response).toBe("The eventual answer");
    expect(responseReads).toBeGreaterThanOrEqual(3);
  });

  it("control: handles the documented 202 processing response", async () => {
    let reads = 0;
    const client = new KoreyClient({
      token: "mock-only-token",
      pollIntervalMs: 0,
      responseTimeoutMs: 1_000,
      fetch: async (input) =>
        String(input).endsWith(`/threads/${threadId}`)
          ? json(thread())
          : ++reads === 1
            ? json({ status: "processing" }, 202)
            : complete(),
    });
    expect(
      formatKoreyMessages(await client.waitForResponse(threadId, messageId)),
    ).toBe("The eventual answer");
    expect(reads).toBe(3);
  });

  it.each(["Message not found", "Thread not found"])(
    "control: %s is still a not-found error",
    async (detail) => {
      let reads = 0;
      const client = new KoreyClient({
        token: "mock-only-token",
        pollIntervalMs: 0,
        fetch: async () => {
          reads += 1;
          return json({ error: "not-found", message: detail }, 404);
        },
      });
      await expect(
        client.waitForResponse(threadId, "invalid-message"),
      ).rejects.toMatchObject({
        status: 404,
        message: `Korey response polling returned 404: ${detail}`,
      });
      expect(reads).toBe(1);
    },
  );

  it("control: a fresh client can recover the accepted message using only GET", async () => {
    const requests: string[] = [];
    const client = new KoreyClient({
      token: "mock-only-token",
      fetch: async (input, init) => {
        requests.push(
          `${init?.method ?? "GET"} ${new URL(String(input)).pathname}`,
        );
        return String(input).endsWith(`/threads/${threadId}`)
          ? json(thread())
          : complete();
      },
    });
    expect(
      formatKoreyMessages(await client.waitForResponse(threadId, messageId)),
    ).toBe("The eventual answer");
    expect(requests).toEqual([
      `GET /api/v1/threads/${threadId}/messages/${messageId}/response`,
      `GET /api/v1/threads/${threadId}`,
      `GET /api/v1/threads/${threadId}/messages/${messageId}/response`,
    ]);
  });

  it("does not finalize a change on an interim response while processing continues", async () => {
    let posts = 0;
    let polls = 0;
    let finalAvailable = false;
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      requests.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/me"))
        return json({
          sub: "mock-user",
          name: "Test",
          email: "test@example.invalid",
          korey_user_id: 1,
          korey_organization_id: 1,
          korey_organization_slug: "mock",
          role: "member",
        });
      if (init?.method === "POST" && path.endsWith("/messages")) {
        posts += 1;
        return json({ message_id: messageId }, 201);
      }
      if (path.endsWith("/response")) {
        polls += 1;
        finalAvailable = polls > 1;
        return complete(
          finalAvailable
            ? "Change applied and verified"
            : "Proceeding with the update now",
        );
      }
      if (path.endsWith(`/threads/${threadId}`))
        return json(thread(posts && !finalAvailable ? "active" : "ready"));
      throw new Error(`Unexpected mocked request: ${path}`);
    });
    const host = await loadHost();
    hosts.push(host);
    const result = await host.harness.callAgentTool("korey_ask", {
      mode: "change",
      prompt: "Make this mocked change and verify it",
    });
    const operations = listOperations(
      host.bb.storage.database(),
      "thread-test",
      100,
    );
    expect(
      requests.filter((request) => request.startsWith("POST")),
    ).toHaveLength(1);
    expect(posts).toBe(1);
    expect(JSON.parse(String(result)).response).toBe(
      "Change applied and verified",
    );
    expect(finalAvailable).toBe(true);
    expect(operations[0]?.status).toBe("korey-complete");
  });
});
