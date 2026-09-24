import { z } from "zod";

export const SHORTCUT_APPROVAL_RENDERER_ID = "shortcut-change-approval";

export const shortcutAttachmentSummarySchema = z
  .object({
    sourcePath: z.string().min(1),
    filename: z.string().min(1),
    contentType: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const unresolvedShortcutOperationSchema = z
  .object({
    operationId: z.string().regex(/^korey-[a-f0-9-]+$/u),
    status: z.enum(["awaiting-response", "reconcile-required"]),
    action: z.enum(["create", "update"]),
    storyId: z.string().nullable(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

export const shortcutApprovalPayloadSchema = z
  .object({
    operationId: z.string().regex(/^korey-[a-f0-9-]+$/u),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/u),
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
    unresolvedOperations: z.array(unresolvedShortcutOperationSchema),
  })
  .strict();

export const shortcutApprovalResponseSchema = z
  .object({
    approved: z.literal(true),
    operationId: z.string().min(1),
    payloadHash: z.string().min(1),
  })
  .strict();

export type ShortcutApprovalPayload = z.infer<
  typeof shortcutApprovalPayloadSchema
>;
export type ShortcutAttachmentSummary = z.infer<
  typeof shortcutAttachmentSummarySchema
>;
