import { setTimeout as sleep } from "node:timers/promises";
import type { AttachmentFile } from "./attachments.js";
import type { z } from "zod";
import { EndpointByMethod } from "../generated/korey-api.js";

const DEFAULT_BASE_URL = "https://api.korey.ai/api/v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

const identityEndpoint = EndpointByMethod.get["/me"];
const listThreadsEndpoint = EndpointByMethod.get["/threads"];
const getThreadEndpoint = EndpointByMethod.get["/threads/{thread-id}"];
const listMessagesEndpoint =
  EndpointByMethod.get["/threads/{thread-id}/messages"];
const createThreadEndpoint = EndpointByMethod.post["/threads"];
const sendMessageEndpoint =
  EndpointByMethod.post["/threads/{thread-id}/messages"];
const uploadEndpoint =
  EndpointByMethod.post["/threads/{thread-id}/attachments"];
const responseEndpoint =
  EndpointByMethod.get["/threads/{thread-id}/messages/{message-id}/response"];

const identitySchema = identityEndpoint.responses[200];
const koreyThreadSchema = getThreadEndpoint.responses[200];
const threadPageSchema = listThreadsEndpoint.responses[200];
const messagePageSchema = listMessagesEndpoint.responses[200];
const createThreadResponseSchema = createThreadEndpoint.responses[201];
const sendMessageResponseSchema = sendMessageEndpoint.responses[201];
const uploadResponseSchema = uploadEndpoint.responses[201];
const completeResponseSchema = responseEndpoint.responses[200];
const processingResponseSchema = responseEndpoint.responses[202];

export type KoreyIdentity = z.infer<typeof identitySchema>;
export type KoreyThread = z.infer<typeof koreyThreadSchema>;
export type KoreyThreadPage = z.infer<typeof threadPageSchema>;
export type KoreyMessagePage = z.infer<typeof messagePageSchema>;
export type KoreyMessage = KoreyMessagePage["data"][number];

type CreateThreadBody = z.input<typeof createThreadEndpoint.parameters.body>;
type CreateThreadResponse = z.infer<typeof createThreadResponseSchema>;
type SendMessageBody = z.input<typeof sendMessageEndpoint.parameters.body>;
type SendMessageResponse = z.infer<typeof sendMessageResponseSchema>;
type UploadResponse = z.infer<typeof uploadResponseSchema>;

export class KoreyApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
    readonly mutationRejected: boolean = false,
  ) {
    super(message);
    this.name = "KoreyApiError";
  }
}

interface KoreyClientOptions {
  token: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  requestTimeoutMs?: number;
  responseTimeoutMs?: number;
  pollIntervalMs?: number;
}

interface RequestOptions {
  form?: FormData;
  body?: unknown;
  method?: "GET" | "POST";
  mutationResponses?: Readonly<Record<number, z.ZodType>>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function parseJson(text: string, context: string, status: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new KoreyApiError(
      `Korey returned invalid JSON for ${context}`,
      status,
    );
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof field === "string" ? field : undefined;
}

function errorDetail(text: string): string {
  if (text.trim().length === 0) return "";
  try {
    const value: unknown = JSON.parse(text);
    return stringField(value, "message") ?? stringField(value, "error") ?? text;
  } catch {
    return text;
  }
}

function parseResponse<T>(
  schema: z.ZodType<T>,
  text: string,
  context: string,
  status: number,
): T {
  try {
    return schema.parse(parseJson(text, context, status));
  } catch (error) {
    if (error instanceof KoreyApiError) throw error;
    throw new KoreyApiError(
      `Korey returned an invalid response for ${context}: ${error instanceof Error ? error.message : String(error)}`,
      status,
    );
  }
}

function endpointPath(
  template: string,
  parameters: Readonly<Record<string, string>> = {},
): string {
  return template.replace(/\{([^}]+)\}/gu, (_match, name: string) => {
    const value = parameters[name];
    if (value === undefined) {
      throw new Error(`Missing Korey API path parameter ${name}`);
    }
    return encodeURIComponent(value);
  });
}

export function formatKoreyMessages(messages: readonly KoreyMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === "user") continue;
    for (const content of message.contents) {
      switch (content.type) {
        case "text":
          if (content.text.trim().length > 0) parts.push(content.text.trim());
          break;
        case "user_get_choice":
          parts.push(
            `${content.question}\nChoices: ${content.choices.join(", ")}`,
          );
          break;
        case "image":
          parts.push(`[Korey image attachment ${content.attachment_id}]`);
          break;
        case "document":
          parts.push(`[Korey document attachment ${content.attachment_id}]`);
          break;
      }
    }
  }
  return parts.join("\n\n");
}

export class KoreyClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly responseTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly token: string;

  constructor(options: KoreyClientOptions) {
    this.token = options.token.trim();
    if (this.token.length === 0) throw new Error("Korey API token is empty");
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.responseTimeoutMs =
      options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  private async fetchPath(
    path: string,
    options: RequestOptions = {},
  ): Promise<{ headers: Headers; status: number; text: string }> {
    const timeoutSignal = AbortSignal.timeout(
      Math.max(1, Math.floor(options.timeoutMs ?? this.requestTimeoutMs)),
    );
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const method = options.method ?? "GET";
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        // A redirect can replay a POST or hide its outcome behind a later GET.
        redirect: method === "GET" ? "follow" : "manual",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          ...(options.body === undefined || options.form !== undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(options.form !== undefined
          ? { body: options.form }
          : options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        signal,
      });
      return {
        headers: response.headers,
        status: response.status,
        text: await response.text(),
      };
    } catch (error) {
      if (options.signal?.aborted) {
        throw new KoreyApiError("Korey request was cancelled");
      }
      if (timeoutSignal.aborted) {
        throw new KoreyApiError("Korey request timed out");
      }
      throw new KoreyApiError(
        `Could not reach Korey: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async request<T>(
    path: string,
    expectedStatus: number,
    schema: z.ZodType<T>,
    options: RequestOptions = {},
  ): Promise<T> {
    const response = await this.fetchPath(path, options);
    if (response.status !== expectedStatus) {
      const unexpectedSuccess = response.status >= 200 && response.status < 300;
      const detail = unexpectedSuccess
        ? ""
        : errorDetail(response.text).trim().slice(0, 500);
      throw new KoreyApiError(
        `Korey API returned ${response.status}${unexpectedSuccess ? `; expected ${expectedStatus}` : ""}${detail.length > 0 ? `: ${detail}` : ""}`,
        response.status,
        options.method === "POST" &&
          response.status >= 400 &&
          response.status < 500 &&
          options.mutationResponses?.[response.status] !== undefined,
      );
    }
    return parseResponse(schema, response.text, path, response.status);
  }

  identity(signal?: AbortSignal): Promise<KoreyIdentity> {
    return this.request(identityEndpoint.path.value, 200, identitySchema, {
      method: identityEndpoint.method.value,
      signal,
    });
  }

  listThreads(
    options: {
      after?: string;
      limit?: number;
      query?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<KoreyThreadPage> {
    const query = new URLSearchParams({
      owned: "true",
      limit: String(options.limit ?? 50),
    });
    if (options.query?.trim()) query.set("q", options.query.trim());
    if (options.after) query.set("after", options.after);
    return this.request(
      `${listThreadsEndpoint.path.value}?${query.toString()}`,
      200,
      threadPageSchema,
      { method: listThreadsEndpoint.method.value, signal: options.signal },
    );
  }

  getThread(threadId: string, signal?: AbortSignal): Promise<KoreyThread> {
    return this.request(
      endpointPath(getThreadEndpoint.path.value, { "thread-id": threadId }),
      200,
      koreyThreadSchema,
      { method: getThreadEndpoint.method.value, signal },
    );
  }

  listMessages(
    threadId: string,
    options: { after?: string; limit?: number; signal?: AbortSignal } = {},
  ): Promise<KoreyMessagePage> {
    const query = new URLSearchParams({ limit: String(options.limit ?? 200) });
    if (options.after) query.set("after", options.after);
    return this.request(
      `${endpointPath(listMessagesEndpoint.path.value, {
        "thread-id": threadId,
      })}?${query.toString()}`,
      200,
      messagePageSchema,
      { method: listMessagesEndpoint.method.value, signal: options.signal },
    );
  }

  async listAllMessages(
    threadId: string,
    signal?: AbortSignal,
    maxMessages = 10_000,
  ): Promise<KoreyMessage[]> {
    const messages: KoreyMessage[] = [];
    let after: string | undefined;
    while (messages.length < maxMessages) {
      const page = await this.listMessages(threadId, {
        after,
        limit: Math.min(200, maxMessages - messages.length),
        signal,
      });
      messages.push(...page.data);
      if (!page.has_more) return messages;
      if (page.last_id === null || page.last_id === after) {
        throw new KoreyApiError("Korey message pagination did not advance");
      }
      after = page.last_id;
    }
    throw new KoreyApiError(
      `Korey conversation exceeds the ${maxMessages}-message reconciliation limit`,
    );
  }

  createThread(
    input: { text: string; name: string; isPrivate: boolean },
    signal?: AbortSignal,
  ): Promise<CreateThreadResponse> {
    const body = {
      text: input.text,
      name: input.name,
      is_private: input.isPrivate,
    } satisfies CreateThreadBody;
    return this.request(
      createThreadEndpoint.path.value,
      201,
      createThreadResponseSchema,
      {
        method: createThreadEndpoint.method.value,
        mutationResponses: createThreadEndpoint.responses,
        body,
        signal,
      },
    );
  }

  sendMessage(
    threadId: string,
    text: string,
    signal?: AbortSignal,
    attachmentIds: readonly string[] = [],
  ): Promise<SendMessageResponse> {
    const body = {
      text,
      ...(attachmentIds.length ? { attachment_ids: [...attachmentIds] } : {}),
    } satisfies SendMessageBody;
    return this.request(
      endpointPath(sendMessageEndpoint.path.value, { "thread-id": threadId }),
      201,
      sendMessageResponseSchema,
      {
        method: sendMessageEndpoint.method.value,
        mutationResponses: sendMessageEndpoint.responses,
        body,
        signal,
      },
    );
  }

  createEmptyThread(
    input: { name: string; isPrivate: boolean },
    signal?: AbortSignal,
  ): Promise<CreateThreadResponse> {
    const body = {
      name: input.name,
      is_private: input.isPrivate,
    } satisfies CreateThreadBody;
    return this.request(
      createThreadEndpoint.path.value,
      201,
      createThreadResponseSchema,
      {
        method: createThreadEndpoint.method.value,
        mutationResponses: createThreadEndpoint.responses,
        body,
        signal,
      },
    );
  }

  async uploadAttachments(
    threadId: string,
    files: readonly AttachmentFile[],
    signal?: AbortSignal,
  ): Promise<UploadResponse> {
    const form = new FormData();
    files.forEach((file, index) => {
      const bytes = new Uint8Array(Buffer.from(file.base64, "base64"));
      form.append(
        `attachments[${index}]`,
        new Blob([bytes], { type: file.contentType }),
        file.filename,
      );
    });
    const uploaded = await this.request(
      endpointPath(uploadEndpoint.path.value, { "thread-id": threadId }),
      201,
      uploadResponseSchema,
      {
        method: uploadEndpoint.method.value,
        mutationResponses: uploadEndpoint.responses,
        form,
        signal,
      },
    );
    if (uploaded.length !== files.length) {
      throw new KoreyApiError(
        `Korey uploaded ${uploaded.length} of ${files.length} attachments`,
      );
    }
    if (new Set(uploaded.map((file) => file.id)).size !== uploaded.length) {
      throw new KoreyApiError("Korey returned duplicate attachment IDs");
    }
    return uploaded;
  }

  async waitForResponse(
    threadId: string,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<KoreyMessage[]> {
    const path = endpointPath(responseEndpoint.path.value, {
      "thread-id": threadId,
      "message-id": messageId,
    });
    const deadline = Date.now() + this.responseTimeoutMs;
    let transientFailures = 0;
    while (true) {
      const remainingBeforeRequest = deadline - Date.now();
      if (remainingBeforeRequest <= 0) {
        throw new KoreyApiError(
          "Korey did not complete the response before the five-minute timeout",
        );
      }
      let response: Awaited<ReturnType<KoreyClient["fetchPath"]>>;
      try {
        response = await this.fetchPath(path, {
          method: responseEndpoint.method.value,
          signal,
          timeoutMs: Math.min(this.requestTimeoutMs, remainingBeforeRequest),
        });
      } catch (error) {
        if (signal?.aborted || !(error instanceof KoreyApiError)) throw error;
        transientFailures += 1;
        await this.waitBeforeRetry(deadline, transientFailures, signal);
        continue;
      }
      if (response.status === 200) {
        return parseResponse(
          completeResponseSchema,
          response.text,
          path,
          response.status,
        ).messages;
      }
      if (response.status === 429 || response.status >= 500) {
        transientFailures += 1;
        await this.waitBeforeRetry(
          deadline,
          transientFailures,
          signal,
          retryAfterMilliseconds(response.headers.get("retry-after")),
        );
        continue;
      }
      if (response.status !== 202) {
        const detail = errorDetail(response.text).trim().slice(0, 500);
        throw new KoreyApiError(
          `Korey response polling returned ${response.status}${detail.length > 0 ? `: ${detail}` : ""}`,
          response.status,
        );
      }
      parseResponse(
        processingResponseSchema,
        response.text,
        path,
        response.status,
      );
      transientFailures = 0;
      await this.waitBeforeRetry(deadline, 1, signal, this.pollIntervalMs);
    }
  }

  private async waitBeforeRetry(
    deadline: number,
    attempt: number,
    signal?: AbortSignal,
    requestedDelayMs?: number,
  ): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new KoreyApiError(
        "Korey did not complete the response before the five-minute timeout",
      );
    }
    const backoff = Math.min(
      10_000,
      Math.max(this.pollIntervalMs, 250) * 2 ** Math.min(attempt - 1, 5),
    );
    const delay = requestedDelayMs ?? backoff;
    if (delay >= remaining) {
      throw new KoreyApiError(
        "Korey did not complete the response before the five-minute timeout",
      );
    }
    await sleep(delay, undefined, { signal });
  }
}

function retryAfterMilliseconds(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}
