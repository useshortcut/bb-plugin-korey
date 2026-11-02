import { z } from "zod";

export const OPERATION_RESOLUTION_RENDERER_ID = "operation-resolution";

export const operationResolutionPayloadSchema = z.strictObject({
  operationId: z.string().min(1),
  resolutionHash: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.enum(["awaiting-response", "reconcile-required"]),
  instruction: z.string(),
  koreyThreadId: z.string().nullable(),
  note: z.string().trim().min(1).max(2_000),
});

export const operationResolutionResponseSchema = z.strictObject({
  confirmed: z.literal(true),
  operationId: z.string().min(1),
  resolutionHash: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const shortcutAttachmentSummarySchema = z
  .object({
    sourcePath: z.string().min(1),
    filename: z.string().min(1),
    contentType: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const shortcutRequestSchema = z
  .object({
    operationId: z.string().regex(/^korey-[a-f0-9-]+$/u),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    bbThreadId: z.string().min(1),
    action: z.enum(["create", "update"]),
    storyId: z.string().nullable(),
    instruction: z.string().trim().min(1).max(20_000),
    koreyOrganization: z.string().min(1),
    destination: z
      .object({
        kind: z.enum(["new-private-thread", "linked-private-thread"]),
        koreyThreadId: z.string().nullable(),
        koreyThreadRevision: z.string().nullable(),
        mappingGeneration: z.number().int().nonnegative(),
      })
      .strict(),
    attachments: z.array(shortcutAttachmentSummarySchema).max(5),
  })
  .strict();

export const connectorChangeRequestSchema = shortcutRequestSchema.extend({
  action: z.literal("change"),
  storyId: z.null(),
});

export const consultationRequestSchema = connectorChangeRequestSchema.extend({
  operationId: z.string().regex(/^korey-consult-[a-f0-9-]+$/u),
  action: z.literal("consult"),
  // Consultations do not require an identity lookup or its additional scope.
  koreyOrganization: z.null(),
});

export const operationRequestSchema = z.union([
  shortcutRequestSchema,
  connectorChangeRequestSchema,
  consultationRequestSchema,
]);

export type OperationRequest = z.infer<typeof operationRequestSchema>;
export type ShortcutRequest = z.infer<typeof shortcutRequestSchema>;
export type ShortcutAttachmentSummary = z.infer<
  typeof shortcutAttachmentSummarySchema
>;

export const CONNECTION_SIGNAL_CHANNEL = "connection";

export const connectionViewSchema = z.strictObject({
  method: z.enum(["oauth", "token", "none"]),
  account: z.string().nullable(),
  error: z.string().nullable(),
  tokenSaved: z.boolean(),
});

export type ConnectionView = z.infer<typeof connectionViewSchema>;

// Plain object rather than defineRpcContract: the app bundle imports this file
// and must not load the server SDK entry.
export const connectionRpcContract = {
  "connection.status": { input: z.null(), output: connectionViewSchema },
  "connection.start": {
    input: z.null(),
    output: z.strictObject({ authorizationUrl: z.string().min(1) }),
  },
  "connection.complete": {
    input: z.strictObject({ redirectUrl: z.string().trim().min(1) }),
    output: connectionViewSchema,
  },
  "connection.disconnect": { input: z.null(), output: connectionViewSchema },
  // bb's settings form cannot clear a secret field.
  "connection.removeToken": { input: z.null(), output: connectionViewSchema },
} as const;
