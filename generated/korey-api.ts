import { z } from "zod";

// <Schemas>
// </Schemas>

// <Endpoints>
export type get__threads_ThreadId_messages = typeof get__threads_ThreadId_messages;
export const get__threads_ThreadId_messages = {
  method: z.literal("GET"),
  path: z.literal("/threads/{thread-id}/messages"),
  requestFormat: z.literal("json"),
  responseFormat: z.literal("json"),
  parameters: {
    query: z
      .strictObject({ limit: z.coerce.number().int().min(1), after: z.string() })
      .partial()
      .optional(),
    path: z.strictObject({ "thread-id": z.uuid() }),
  },
  responses: {
    200: z.strictObject({
      data: z.array(
        z.strictObject({
          id: z.string(),
          thread_id: z.string(),
          role: z.enum(["user", "assistant", "summary"]),
          contents: z.array(
            z.union([
              z.strictObject({ type: z.literal("text"), text: z.string() }),
              z.strictObject({ type: z.literal("image"), attachment_id: z.string() }),
              z.strictObject({ type: z.literal("document"), attachment_id: z.string() }),
              z.strictObject({
                type: z.literal("user_get_choice"),
                tool_use_id: z.string(),
                question: z.string(),
                choices: z.array(z.string()),
              }),
            ]),
          ),
          created_at: z.string(),
          app_url: z.string(),
        }),
      ),
      first_id: z.string().nullable(),
      last_id: z.string().nullable(),
      has_more: z.boolean(),
      limit: z.number().int().min(1),
    }),
    401: z.unknown(),
    403: z.unknown(),
    404: z.strictObject({ error: z.string(), message: z.string() }),
  },
};

export type post__threads_ThreadId_messages = typeof post__threads_ThreadId_messages;
export const post__threads_ThreadId_messages = {
  method: z.literal("POST"),
  path: z.literal("/threads/{thread-id}/messages"),
  requestFormat: z.literal("json"),
  responseFormat: z.literal("json"),
  parameters: {
    path: z.strictObject({ "thread-id": z.uuid() }),
    body: z.strictObject({ text: z.string().min(1), attachment_ids: z.array(z.uuid()).max(25).optional() }),
  },
  responses: {
    201: z.strictObject({ message_id: z.string() }),
    401: z.unknown(),
    403: z.strictObject({ error: z.string(), message: z.string() }),
    404: z.strictObject({ error: z.string(), message: z.string() }),
    409: z.strictObject({ error: z.string(), message: z.string() }),
  },
};

export type post__threads_ThreadId_messages_MessageId_feedback =
  typeof post__threads_ThreadId_messages_MessageId_feedback;
export const post__threads_ThreadId_messages_MessageId_feedback = {
  method: z.literal("POST"),
  path: z.literal("/threads/{thread-id}/messages/{message-id}/feedback"),
  requestFormat: z.literal("json"),
  responseFormat: z.literal("json"),
  parameters: {
    path: z.strictObject({ "thread-id": z.uuid(), "message-id": z.uuid() }),
    body: z.strictObject({ positive: z.boolean(), feedback_text: z.string().max(1024).optional() }),
  },
  responses: { 204: z.null(), 401: z.unknown(), 403: z.unknown() },
};

export type get__threads_ThreadId_messages_MessageId_response_stream =
  typeof get__threads_ThreadId_messages_MessageId_response_stream;
export const get__threads_ThreadId_messages_MessageId_response_stream = {
  method: z.literal("GET"),
  path: z.literal("/threads/{thread-id}/messages/{message-id}/response/stream"),
  requestFormat: z.literal("json"),
  responseFormat: z.literal("json"),
  parameters: { path: z.strictObject({ "thread-id": z.uuid(), "message-id": z.uuid() }) },
  responses: { 401: z.unknown(), 403: z.unknown() },
};

export type get__threads = typeof get__threads;
export const get__threads = {
  method: z.literal("GET"),
  path: z.literal("/threads"),
  requestFormat: z.literal("json"),
  responseFormat: z.literal("json"),
  parameters: {
    query: z
      .strictObject({
        owned: z
          .union([z.boolean(), z.string(), z.number()])
          .transform((x) => x === true || x === "true" || x === 1 || x === "1"),
        private: z
          .union([z.boolean(), z.string(), z.number()])
          .transform((x) => x === true || x === "true" || x === 1 || x === "1"),
        archived: z
          .union([z.boolean(), z.string(), z.number()])
          .transform((x) => x === true || x === "true" || x === 1 || x === "1"),
        q: z.string(),
        sort_by: z.enum(["updated_at", "created_at"]),
        sort_dir: z.enum(["asc", "desc"]),
        updated_since: z.string(),
        limit: z.coerce.number().int().min(1),
        after: z.string(),
      })
      .partial()
      .optional(),
  },
  responses: {
    200: z.strictObject({
      data: z.array(
        z.strictObject({
          id: z.string(),
          name: z.string().nullable(),
          state: z.enum(["ready", "waiting", "active", "error", "interrupted"]),
          is_private: z.boolean(),
          archived: z.boolean(),
          owner: z.strictObject({ id: z.string(), name: z.string().nullable() }),
          created_at: z.string(),
          updated_at: z.string(),
          app_url: z.string(),
        }),
      ),
      first_id: z.string().nullable(),
      last_id: z.string().nullable(),
      has_more: z.boolean(),
      limit: z.number().int().min(1),
    }),
    401: z.unknown(),
    403: z.unknown(),
  },
};

export type post__threads = typeof post__threads;
export const post__threads = {
  method: z.literal("POST"),
  path: z.literal("/threads"),
  requestFormat: z.literal("json"),
  responseFormat: z.literal("json"),
  parameters: {
    body: z
      .strictObject({ text: z.string().min(1), name: z.string().nullable(), is_private: z.boolean() })
      .partial()
      .optional(),
  },
  responses: {
    201: z.strictObject({ thread_id: z.string(), message_id: z.string().nullable() }),
    401: z.unknown(),
    403: z.unknown(),
    409: z.strictObject({ error: z.string(), message: z.string() }),
  },
};

export type post__threads_ThreadId_attachments = typeof post__threads_ThreadId_attachments;
export const post__threads_ThreadId_attachments = {
  method: z.literal("POST"),
  path: z.literal("/threads/{thread-id}/attachments"),
  requestFormat: z.literal("form-data"),
  responseFormat: z.literal("json"),
  parameters: {
    path: z.strictObject({ "thread-id": z.uuid() }),
    body: z
      .object({ "attachments[0]": z.custom<Blob>((v) => typeof Blob !== "undefined" && v instanceof Blob) })
      .catchall(z.custom<Blob>((v) => typeof Blob !== "undefined" && v instanceof Blob)),
  },
  responses: {
    201: z.array(z.strictObject({ id: z.uuid(), filename: z.string() })),
    400: z.object({ message: z.string() }).catchall(z.unknown()),
    401: z.unknown(),
    403: z.strictObject({ error: z.string(), message: z.string() }),
    404: z.strictObject({ error: z.string(), message: z.string() }),
    422: z
      .object({ message: z.string(), reason: z.object({}).partial().catchall(z.unknown()).optional() })
      .catchall(z.unknown()),
  },
};

export type get__threads_ThreadId = typeof get__threads_ThreadId;
export const get__threads_ThreadId = {
  method: z.literal("GET"),
  path: z.literal("/threads/{thread-id}"),
  requestFormat: z.literal("json"),
  responseFormat: z.literal("json"),
  parameters: { path: z.strictObject({ "thread-id": z.uuid() }) },
  responses: {
    200: z.strictObject({
      id: z.string(),
      name: z.string().nullable(),
      state: z.enum(["ready", "waiting", "active", "error", "interrupted"]),
      is_private: z.boolean(),
      archived: z.boolean(),
      owner: z.strictObject({ id: z.string(), name: z.string().nullable() }),
      created_at: z.string(),
      updated_at: z.string(),
      app_url: z.string(),
    }),
    401: z.unknown(),
    403: z.unknown(),
    404: z.strictObject({ error: z.string(), message: z.string() }),
  },
};

export type get__me = typeof get__me;
export const get__me = {
  method: z.literal("GET"),
  path: z.literal("/me"),
  requestFormat: z.literal("json"),
  responseFormat: z.literal("json"),
  parameters: z.never(),
  responses: {
    200: z.strictObject({
      sub: z.string(),
      name: z.string().nullable(),
      email: z.string().nullable(),
      korey_user_id: z.number().int(),
      korey_organization_id: z.number().int(),
      korey_organization_slug: z.string(),
      role: z.string(),
    }),
    401: z.unknown(),
    403: z.unknown(),
  },
};

export type get__threads_ThreadId_messages_MessageId_response =
  typeof get__threads_ThreadId_messages_MessageId_response;
export const get__threads_ThreadId_messages_MessageId_response = {
  method: z.literal("GET"),
  path: z.literal("/threads/{thread-id}/messages/{message-id}/response"),
  requestFormat: z.literal("json"),
  responseFormat: z.literal("json"),
  parameters: { path: z.strictObject({ "thread-id": z.uuid(), "message-id": z.uuid() }) },
  responses: {
    200: z.strictObject({
      status: z.literal("complete"),
      messages: z.array(
        z.strictObject({
          id: z.string(),
          thread_id: z.string(),
          role: z.enum(["user", "assistant", "summary"]),
          contents: z.array(
            z.union([
              z.strictObject({ type: z.literal("text"), text: z.string() }),
              z.strictObject({ type: z.literal("image"), attachment_id: z.string() }),
              z.strictObject({ type: z.literal("document"), attachment_id: z.string() }),
              z.strictObject({
                type: z.literal("user_get_choice"),
                tool_use_id: z.string(),
                question: z.string(),
                choices: z.array(z.string()),
              }),
            ]),
          ),
          created_at: z.string(),
          app_url: z.string(),
        }),
      ),
    }),
    202: z.strictObject({ status: z.literal("processing") }),
    401: z.unknown(),
    403: z.unknown(),
    404: z.strictObject({ error: z.string(), message: z.string() }),
  },
};

// </Endpoints>

// <EndpointByMethod>
export const EndpointByMethod = {
  get: {
    "/threads/{thread-id}/messages": get__threads_ThreadId_messages,
    "/threads/{thread-id}/messages/{message-id}/response/stream":
      get__threads_ThreadId_messages_MessageId_response_stream,
    "/threads": get__threads,
    "/threads/{thread-id}": get__threads_ThreadId,
    "/me": get__me,
    "/threads/{thread-id}/messages/{message-id}/response": get__threads_ThreadId_messages_MessageId_response,
  },
  post: {
    "/threads/{thread-id}/messages": post__threads_ThreadId_messages,
    "/threads/{thread-id}/messages/{message-id}/feedback": post__threads_ThreadId_messages_MessageId_feedback,
    "/threads": post__threads,
    "/threads/{thread-id}/attachments": post__threads_ThreadId_attachments,
  },
};
export type EndpointByMethod = typeof EndpointByMethod;
// </EndpointByMethod>

// <EndpointByMethod.Shorthands>
export type GetEndpoints = EndpointByMethod["get"];
export type PostEndpoints = EndpointByMethod["post"];
// </EndpointByMethod.Shorthands>
