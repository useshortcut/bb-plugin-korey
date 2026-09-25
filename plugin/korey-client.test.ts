import { describe, expect, it } from "vitest";
import {
  formatKoreyMessages,
  KoreyApiError,
  KoreyClient,
} from "./korey-client.js";
import { withHttpServer } from "./testing/http-server.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function assistantMessage(threadId: string, text: string) {
  return {
    id: "message-assistant",
    thread_id: threadId,
    role: "assistant",
    contents: [{ type: "text", text }],
    created_at: "2026-08-21T12:00:00.000Z",
    app_url: `https://app.korey.ai/threads/${threadId}/messages/message-assistant`,
  };
}

function koreyThreadResponse() {
  return {
    id: "thread-one",
    name: null,
    state: "ready",
    is_private: true,
    archived: false,
    owner: { id: "user-one", name: "bb User" },
    created_at: "2026-08-21T12:00:00.000Z",
    updated_at: "2026-08-21T12:00:00.000Z",
    app_url: "https://app.korey.ai/threads/thread-one",
  };
}

describe("KoreyClient", () => {
  it("accepts additive response fields and preserves unknown content as a visible placeholder", async () => {
    const thread = koreyThreadResponse();
    const message = {
      ...assistantMessage(thread.id, "Done"),
      extra: true,
      contents: [
        { type: "text", text: "Done", annotations: [] },
        { type: "connector_result", result: { ok: true } },
      ],
    };
    const responses = [
      jsonResponse({
        ...thread,
        extra: true,
        owner: { ...thread.owner, extra: true },
      }),
      jsonResponse({ message_id: "sent", extra: true }, 201),
      jsonResponse({ status: "processing", extra: true }, 202),
      jsonResponse({ status: "complete", messages: [message], extra: true }),
      jsonResponse({
        data: [message],
        first_id: message.id,
        last_id: message.id,
        has_more: false,
        limit: 200,
        extra: true,
      }),
    ];
    const client = new KoreyClient({
      token: "test",
      pollIntervalMs: 0,
      fetch: async () => responses.shift()!,
    });
    await expect(client.getThread(thread.id)).resolves.toEqual(thread);
    await expect(
      client.sendMessage(thread.id, "Create a Story"),
    ).resolves.toEqual({ message_id: "sent" });
    const messages = await client.waitForResponse(thread.id, "sent");
    expect(formatKoreyMessages(messages)).toContain(
      "Done\n\n[Unsupported Korey content: connector_result;",
    );
    expect(formatKoreyMessages(messages)).toContain(message.app_url);
    await expect(client.listAllMessages(thread.id)).resolves.toEqual(messages);
  });

  it("still rejects malformed known content blocks", async () => {
    const client = new KoreyClient({
      token: "test",
      fetch: async () =>
        jsonResponse({
          status: "complete",
          messages: [
            {
              ...assistantMessage("thread-one", "Done"),
              contents: [{ type: "text", text: 42 }],
            },
          ],
        }),
    });
    await expect(client.waitForResponse("thread-one", "sent")).rejects.toThrow(
      "invalid response",
    );
  });

  it.each([307, 308])(
    "does not replay a message POST after HTTP %i",
    async (status) => {
      const calls: string[] = [];
      await withHttpServer(
        (request) => {
          calls.push(`${request.method} ${request.url}`);
          return request.url === "/threads/thread-one/messages"
            ? new Response(null, {
                status,
                headers: { location: "/redirected" },
              })
            : jsonResponse({ message_id: "replayed-message" }, 201);
        },
        async (baseUrl) => {
          const client = new KoreyClient({ token: "kt_pat_test", baseUrl });
          await expect(
            client.sendMessage("thread-one", "Create one Story"),
          ).rejects.toMatchObject({
            status,
            mutationRejected: false,
          });
          expect(calls).toEqual(["POST /threads/thread-one/messages"]);
        },
      );
    },
  );

  it("continues to follow redirects for read-only requests", async () => {
    const calls: string[] = [];
    await withHttpServer(
      (request) => {
        calls.push(`${request.method} ${request.url}`);
        return request.url === "/threads/thread-one"
          ? new Response(null, {
              status: 307,
              headers: { location: "/redirected" },
            })
          : jsonResponse(koreyThreadResponse());
      },
      async (baseUrl) => {
        const client = new KoreyClient({ token: "kt_pat_test", baseUrl });
        await expect(client.getThread("thread-one")).resolves.toEqual(
          koreyThreadResponse(),
        );
        expect(calls).toEqual(["GET /threads/thread-one", "GET /redirected"]);
      },
    );
  });

  it("polls a sent message to completion without duplicating the /api/v1 prefix", async () => {
    const responses = [
      jsonResponse({ message_id: "message-user" }, 201),
      jsonResponse({ status: "processing" }, 202),
      jsonResponse({
        status: "complete",
        messages: [assistantMessage("thread/one", "Draft ready")],
      }),
    ];
    const calls: Array<{ init: RequestInit | undefined; url: string }> = [];
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      const response = responses.shift();
      if (response === undefined) throw new Error("Unexpected fetch");
      return response;
    };
    const client = new KoreyClient({
      token: "kt_pat_test",
      baseUrl: "https://api.korey.test/api/v1",
      fetch: fetchImpl,
      pollIntervalMs: 0,
    });

    const sent = await client.sendMessage("thread/one", "hello");
    const messages = await client.waitForResponse(
      "thread/one",
      sent.message_id,
    );

    expect(messages).toHaveLength(1);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.korey.test/api/v1/threads/thread%2Fone/messages",
      "https://api.korey.test/api/v1/threads/thread%2Fone/messages/message-user/response",
      "https://api.korey.test/api/v1/threads/thread%2Fone/messages/message-user/response",
    ]);
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: "Bearer kt_pat_test",
      "content-type": "application/json",
    });
  });

  it("returns Korey's status and error detail without retrying a conflict", async () => {
    let requestCount = 0;
    const fetchImpl: typeof globalThis.fetch = async () => {
      requestCount += 1;
      return jsonResponse(
        { error: "conflict", message: "Thread is not ready" },
        409,
      );
    };
    const client = new KoreyClient({
      token: "kt_pat_test",
      fetch: fetchImpl,
    });

    const result = client.sendMessage("thread-one", "hello");
    await expect(result).rejects.toMatchObject({
      name: "KoreyApiError",
      status: 409,
      message: "Korey API returned 409: Thread is not ready",
    } satisfies Partial<KoreyApiError>);
    expect(requestCount).toBe(1);
  });

  it("uploads multiple files with ordered multipart field names", async () => {
    let request: RequestInit | undefined;
    const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
      request = init;
      return jsonResponse(
        [
          {
            id: "00000000-0000-4000-8000-000000000001",
            filename: "screenshot.png",
          },
          {
            id: "00000000-0000-4000-8000-000000000002",
            filename: "notes.md",
          },
        ],
        201,
      );
    };
    const client = new KoreyClient({ token: "kt_pat_test", fetch: fetchImpl });

    await client.uploadAttachments("thread-one", [
      {
        filename: "screenshot.png",
        contentType: "image/png",
        base64: Buffer.from("image").toString("base64"),
      },
      {
        filename: "notes.md",
        contentType: "text/markdown",
        base64: Buffer.from("notes").toString("base64"),
      },
    ]);

    expect(request?.body).toBeInstanceOf(FormData);
    const form = request?.body;
    if (!(form instanceof FormData)) throw new Error("Expected multipart body");
    expect([...form.keys()]).toEqual(["attachments[0]", "attachments[1]"]);
    const screenshot = form.get("attachments[0]");
    const notes = form.get("attachments[1]");
    expect(screenshot).toBeInstanceOf(File);
    expect(notes).toBeInstanceOf(File);
    if (!(screenshot instanceof File) || !(notes instanceof File)) {
      throw new Error("Expected uploaded files");
    }
    expect([screenshot.name, screenshot.type, await screenshot.text()]).toEqual(
      ["screenshot.png", "image/png", "image"],
    );
    expect([notes.name, notes.type, await notes.text()]).toEqual([
      "notes.md",
      "text/markdown",
      "notes",
    ]);
  });

  it("rejects a partial attachment response before a message can reference it", async () => {
    const client = new KoreyClient({
      token: "kt_pat_test",
      fetch: async () => jsonResponse([], 201),
    });

    await expect(
      client.uploadAttachments("thread-one", [
        {
          filename: "screenshot.png",
          contentType: "image/png",
          base64: Buffer.from("image").toString("base64"),
        },
      ]),
    ).rejects.toThrow("Korey uploaded 0 of 1 attachments");
  });

  it("rejects an unexpected success status", async () => {
    const fetchImpl: typeof globalThis.fetch = async () =>
      jsonResponse(koreyThreadResponse(), 201);
    const client = new KoreyClient({ token: "kt_pat_test", fetch: fetchImpl });

    await expect(client.getThread("thread-one")).rejects.toMatchObject({
      name: "KoreyApiError",
      status: 201,
      message: "Korey API returned 201; expected 200",
    } satisfies Partial<KoreyApiError>);
  });

  it("validates successful responses against the generated OpenAPI schema", async () => {
    const fetchImpl: typeof globalThis.fetch = async () =>
      jsonResponse({
        id: "thread-one",
        name: null,
        state: "ready",
        is_private: true,
        archived: false,
        created_at: "2026-08-21T12:00:00.000Z",
        updated_at: "2026-08-21T12:00:00.000Z",
        app_url: "https://app.korey.ai/threads/thread-one",
      });
    const client = new KoreyClient({
      token: "kt_pat_test",
      fetch: fetchImpl,
    });

    await expect(client.getThread("thread-one")).rejects.toMatchObject({
      name: "KoreyApiError",
      status: 200,
      message: expect.stringContaining("Korey returned an invalid response"),
    } satisfies Partial<KoreyApiError>);
  });

  it("retries transient polling reads without retrying a mutation", async () => {
    const responses = [
      new Response(JSON.stringify({ error: "busy" }), {
        status: 503,
        headers: { "retry-after": "0" },
      }),
      jsonResponse({
        status: "complete",
        messages: [assistantMessage("thread-one", "Recovered")],
      }),
    ];
    const calls: string[] = [];
    const client = new KoreyClient({
      token: "kt_pat_test",
      fetch: async (input) => {
        calls.push(String(input));
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected fetch");
        return response;
      },
      pollIntervalMs: 0,
      responseTimeoutMs: 1_000,
    });

    const messages = await client.waitForResponse("thread-one", "message-one");

    expect(messages[0]?.contents).toEqual([
      { type: "text", text: "Recovered" },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("stops when Retry-After exceeds the remaining response deadline", async () => {
    let requestCount = 0;
    const client = new KoreyClient({
      token: "kt_pat_test",
      fetch: async () => {
        requestCount += 1;
        return new Response(JSON.stringify({ error: "busy" }), {
          status: 503,
          headers: { "retry-after": "1" },
        });
      },
      responseTimeoutMs: 100,
    });

    await expect(
      client.waitForResponse("thread-one", "message-one"),
    ).rejects.toThrow(
      "Korey did not complete the response before the five-minute timeout",
    );
    expect(requestCount).toBe(1);
  });

  it("paginates through all messages for read-only reconciliation", async () => {
    const responses = [
      jsonResponse({
        data: [assistantMessage("thread-one", "First")],
        first_id: "message-1",
        last_id: "message-1",
        has_more: true,
        limit: 1,
      }),
      jsonResponse({
        data: [
          {
            ...assistantMessage("thread-one", "Second"),
            id: "message-2",
          },
        ],
        first_id: "message-2",
        last_id: "message-2",
        has_more: false,
        limit: 1,
      }),
    ];
    const calls: string[] = [];
    const client = new KoreyClient({
      token: "kt_pat_test",
      fetch: async (input) => {
        calls.push(String(input));
        const response = responses.shift();
        if (response === undefined) throw new Error("Unexpected fetch");
        return response;
      },
    });

    const messages = await client.listAllMessages("thread-one", undefined, 2);

    expect(messages.map((message) => message.id)).toEqual([
      "message-assistant",
      "message-2",
    ]);
    expect(calls[1]).toContain("after=message-1");
  });
});
