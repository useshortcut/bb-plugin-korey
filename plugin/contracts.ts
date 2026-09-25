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

export const operationRequestSchema = z.union([
  shortcutRequestSchema,
  connectorChangeRequestSchema,
]);

export type OperationRequest = z.infer<typeof operationRequestSchema>;
export type ShortcutRequest = z.infer<typeof shortcutRequestSchema>;
export type ShortcutAttachmentSummary = z.infer<
  typeof shortcutAttachmentSummarySchema
>;
