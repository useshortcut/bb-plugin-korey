import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
export const MAX_PDF_ATTACHMENT_BYTES = Math.floor(2.5 * 1024 * 1024);
export const MAX_TEXT_ATTACHMENT_BYTES = Math.floor(0.5 * 1024 * 1024);
export const filePathsSchema = z
  .array(z.string().trim().min(1))
  .max(5)
  .superRefine((paths, context) => {
    const seen = new Set<string>();
    paths.forEach((path, index) => {
      if (seen.has(path)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Duplicate attachment path",
        });
      }
      seen.add(path);
    });
  });
const attachmentFileSchema = z
  .object({
    filename: z.string().min(1),
    contentType: z.string().min(1),
    base64: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4),
  })
  .strict();
export const attachmentSchema = attachmentFileSchema
  .extend({ identity: z.string().min(1) })
  .strict();
export type AttachmentFile = z.infer<typeof attachmentFileSchema>;
export type ReadAttachmentResult = z.infer<typeof attachmentSchema>;

export const hostContract = defineRpcContract({
  readAttachment: {
    input: z
      .object({
        path: z.string().trim().min(1),
        workspaceRoot: z.string().min(1),
      })
      .strict(),
    output: attachmentSchema,
  },
});
