import { createHash, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  filePathsSchema,
  hostContract,
  type AttachmentFile,
} from "./attachments.js";
import {
  OPERATION_RESOLUTION_RENDERER_ID,
  operationResolutionPayloadSchema,
  operationResolutionResponseSchema,
  shortcutRequestSchema,
  type ShortcutRequest,
  type ShortcutAttachmentSummary,
} from "./contracts.js";
import {
  beginMappingCreate,
  completeMappingCreate,
  createOperation,
  getMapping,
  getOperation,
  listOperations,
  listUnresolvedOperations,
  migrations,
  recoverInterruptedOperations,
  rejectMappingCreate,
  requireMappingReconciliation,
  reserveMapping,
  setLinkedMapping,
  setUnlinkedMapping,
  transitionOperation,
  updateOperationError,
  type MappingRecord,
  type OperationRecord,
} from "./data.js";
import {
  formatKoreyMessages,
  KoreyApiError,
  KoreyClient,
  type KoreyMessage,
  type KoreyThread,
} from "./korey-client.js";

const CONSULT_PREFIX = [
  "This request is consultation-only.",
  "Do not create, update, archive, assign, or delete anything in Shortcut or any other connected system.",
  "Return analysis or a draft only.",
  "",
].join("\n");
const MAPPING_MARKER_PREFIX = "bb-korey";
const MAX_STORED_RESPONSE_BYTES = 64 * 1024;
const INTERACTION_TIMEOUT_MS = 10 * 60_000;
const API_TOKEN_URL = "https://app.korey.ai/settings/api-tokens";
const TOKEN_SETUP_GUIDANCE = `Create a Korey personal access token at ${API_TOKEN_URL} and add it under Settings -> Installed plugins -> Korey.`;

const CLI_COMMANDS = [
  {
    name: "status",
    summary: "Check Korey authentication",
    usage: "bb korey status [--json]",
  },
  {
    name: "threads",
    summary: "List owned Korey threads",
    usage:
      "bb korey threads [query...] [--after <cursor>] [--limit <count>] [--json]",
  },
  {
    name: "show",
    summary: "Show a Korey thread and one page of messages",
    usage:
      "bb korey show <korey-thread-id> [--after <cursor>] [--limit <count>] [--json]",
  },
  {
    name: "link",
    summary: "Link a private Korey thread to a bb thread",
    usage: "bb korey link <korey-thread-id> [--bb-thread <id>] [--json]",
  },
  {
    name: "unlink",
    summary: "Remove a bb-to-Korey thread link",
    usage: "bb korey unlink [--bb-thread <id>] [--json]",
  },
  {
    name: "ask",
    summary: "Ask Korey to research connected tools or prepare a draft",
    usage:
      "bb korey ask <message...> [--file <path> ...] [--bb-thread <id>] [--json]",
  },
  {
    name: "shortcut",
    summary:
      "Ask Korey to create or update a Shortcut Story at the user's request",
    usage: [
      "bb korey shortcut create <instruction...> [--file <path> ...] [--bb-thread <id>] [--json]",
      "bb korey shortcut update <story-id> <instruction...> [--file <path> ...] [--bb-thread <id>] [--json]",
    ].join("\n  "),
  },
  {
    name: "operation",
    summary: "Inspect or safely recover a Shortcut operation",
    usage: [
      "bb korey operation list [--limit <count>] [--bb-thread <id>] [--json]",
      "bb korey operation show <operation-id> [--bb-thread <id>] [--json]",
      "bb korey operation resume <operation-id> [--bb-thread <id>] [--json]",
      "bb korey operation reconcile <operation-id> [--bb-thread <id>] [--json]",
      "bb korey operation resolve <operation-id> <note...> [--bb-thread <id>] [--json]",
    ].join("\n  "),
  },
];

const shortcutChangeInputSchema = z
  .object({
    action: z.enum(["create", "update"]),
    storyId: z.string().optional(),
    instruction: z.string().trim().min(1).max(20_000),
    files: filePathsSchema
      .optional()
      .describe(
        "Files to send with the Shortcut request. Paths are relative to this thread's workspace. Up to 5 files.",
      ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.action === "update" && value.storyId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["storyId"],
        message: "storyId is required for an update",
      });
    }
    if (value.action === "create" && value.storyId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["storyId"],
        message: "storyId is not allowed for a create",
      });
    }
  });

type ShortcutChangeInput = z.infer<typeof shortcutChangeInputSchema>;

interface LinkedThread {
  created: boolean;
  koreyThread: KoreyThread;
  responseText: string;
  responseTruncated: boolean;
}

interface PreparedAttachment {
  file: AttachmentFile;
  identity: string;
  summary: ShortcutAttachmentSummary;
}

function toolError(error: unknown): PluginAgentToolResult {
  return {
    content: [
      {
        type: "text",
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

async function executeJsonTool(
  execute: () => Promise<unknown>,
): Promise<string | PluginAgentToolResult> {
  try {
    return JSON.stringify(await execute(), null, 2);
  } catch (error) {
    return toolError(error);
  }
}

function cliOutput(json: boolean, value: unknown, text: string) {
  return {
    exitCode: 0,
    stdout: json ? JSON.stringify(value, null, 2) : text,
  };
}

function normalizeStoryId(value: string): string | null {
  const match = /^(?:sc-)?([1-9][0-9]*)$/iu.exec(value.trim());
  return match?.[1] === undefined ? null : `sc-${match[1]}`;
}

function hash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function mutationWasRejected(error: unknown): boolean {
  return error instanceof KoreyApiError && error.mutationRejected;
}

function boundedText(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= MAX_STORED_RESPONSE_BYTES) {
    return { text, truncated: false };
  }
  const prefix = bytes
    .subarray(0, MAX_STORED_RESPONSE_BYTES)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return {
    text: `${prefix}\n\n[Response truncated by bb-plugin-korey; open the Korey conversation to read the full response.]`,
    truncated: true,
  };
}

// Keep history readable across request schema versions. Missing future fields
// are shown as unknown; this projection is never used to authorize a write.
const storedRequestSummarySchema = z.object({
  action: z.enum(["create", "update", "unknown"]).catch("unknown"),
  storyId: z.string().nullable().catch(null),
  instruction: z.string().catch("[Unavailable in this request version]"),
  attachments: z.array(z.unknown()).catch([]),
  koreyOrganization: z.string().catch("Unknown"),
});

function operationView(operation: OperationRecord) {
  const summary = storedRequestSummarySchema.parse(operation.request);
  return {
    operationId: operation.id,
    status: operation.status,
    ...summary,
    requestVersion: operation.requestVersion,
    requestHash: operation.requestHash,
    koreyThreadId: operation.koreyThreadId,
    koreyMessageId: operation.koreyMessageId,
    attachmentIds: operation.attachmentIds,
    response: operation.responseText,
    responseTruncated: operation.responseTruncated,
    resolutionNote: operation.resolutionNote,
    error: operation.error,
    createdAt: new Date(operation.createdAt).toISOString(),
    updatedAt: new Date(operation.updatedAt).toISOString(),
    approvedAt:
      operation.approvedAt === null
        ? null
        : new Date(operation.approvedAt).toISOString(),
    completedAt:
      operation.completedAt === null
        ? null
        : new Date(operation.completedAt).toISOString(),
  };
}

function parseCommonCliArgs(argv: string[]) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      after: { type: "string", multiple: true },
      "bb-thread": { type: "string", multiple: true },
      file: { type: "string", multiple: true },
      json: { type: "boolean" },
      limit: { type: "string", multiple: true },
    },
    strict: true,
  });
  const bbThreadIds = values["bb-thread"];
  const afterValues = values.after;
  const limitValues = values.limit;
  if (bbThreadIds !== undefined && bbThreadIds.length > 1) {
    throw new Error("--bb-thread may be provided only once");
  }
  if (afterValues !== undefined && afterValues.length > 1) {
    throw new Error("--after may be provided only once");
  }
  if (limitValues !== undefined && limitValues.length > 1) {
    throw new Error("--limit may be provided only once");
  }
  const rawLimit = limitValues?.[0];
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > 200)
  ) {
    throw new Error("--limit must be an integer from 1 to 200");
  }
  return {
    after: afterValues?.[0],
    bbThreadId: bbThreadIds?.[0],
    files: values.file === undefined ? [] : filePathsSchema.parse(values.file),
    json: values.json ?? false,
    limit,
    positional: positionals,
  };
}

function cliThreadId(
  explicitThreadId: string | undefined,
  contextThreadId: string | undefined,
): string {
  const threadId = explicitThreadId ?? contextThreadId;
  if (threadId === undefined) {
    throw new Error(
      "This command needs a bb thread. Run it inside an agent thread or pass --bb-thread <thread-id>.",
    );
  }
  return threadId;
}

function plainThreadList(threads: readonly KoreyThread[]): string {
  if (threads.length === 0) return "No owned Korey threads found.";
  return threads
    .map(
      (thread) =>
        `${thread.id}\t${thread.state}\t${thread.is_private ? "private" : "shared"}\t${thread.name ?? "Untitled"}`,
    )
    .join("\n");
}

function plainConversation(
  thread: KoreyThread,
  messages: readonly KoreyMessage[],
  hasMore: boolean,
): string {
  const transcript = messages
    .map((message) => {
      const text = message.contents
        .map((content) => {
          if (content.type === "text") return content.text;
          if (content.type === "user_get_choice") {
            return `${content.question} [${content.choices.join(" / ")}]`;
          }
          if (content.type === "unknown") {
            return `[Unsupported Korey content: ${content.originalType}; view ${message.app_url}]`;
          }
          return `[${content.type} attachment ${content.attachment_id}]`;
        })
        .join("\n");
      return `${message.role}: ${text}`;
    })
    .join("\n\n");
  return [
    thread.name ?? "Untitled Korey thread",
    thread.app_url,
    "",
    transcript,
    ...(hasMore
      ? ["", "More messages are available; continue with --after."]
      : []),
  ].join("\n");
}

function usage(): string {
  return ["Usage:", ...CLI_COMMANDS.map(({ usage }) => `  ${usage}`)].join(
    "\n",
  );
}

function assertPrivateThread(thread: KoreyThread): void {
  if (!thread.is_private) {
    throw new Error(
      `Korey thread ${thread.id} is shared. bb-plugin-korey links only private conversations.`,
    );
  }
}

function operationMarker(operationId: string, legacy = false): string {
  // Version 1 reconciliation requires the original uppercase marker.
  const productName = legacy ? "bb".toUpperCase() : "bb";
  return `${productName} operation reference: ${operationId}`;
}

function consultationMarker(consultationId: string): string {
  return `bb consultation reference: ${consultationId}`;
}

export default async function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  recoverInterruptedOperations(db);

  const settings = bb.settings.define({
    apiToken: {
      type: "string",
      label: "Korey personal access token",
      description: `Create a token at ${API_TOKEN_URL} with threads:read and threads:write scopes.`,
      secret: true,
    },
  });

  if (!(await settings.get()).apiToken?.trim()) {
    bb.status.needsConfiguration(TOKEN_SETUP_GUIDANCE);
  }

  async function client(): Promise<KoreyClient> {
    const apiToken = (await settings.get()).apiToken?.trim();
    if (!apiToken) {
      throw new Error(`Korey is not configured. ${TOKEN_SETUP_GUIDANCE}`);
    }
    return new KoreyClient({ token: apiToken });
  }

  const threadTails = new Map<string, Promise<void>>();
  async function withThreadLock<T>(
    bbThreadId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = threadTails.get(bbThreadId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => current);
    threadTails.set(bbThreadId, tail);
    await previous.catch(() => undefined);
    try {
      return await run();
    } finally {
      release();
      if (threadTails.get(bbThreadId) === tail) {
        threadTails.delete(bbThreadId);
      }
    }
  }

  async function bbThreadName(
    bbThreadId: string,
    marker: string,
  ): Promise<string> {
    const thread = await bb.sdk.threads.get({ threadId: bbThreadId });
    const label = thread.title?.trim() || thread.id;
    const suffix = ` [${MAPPING_MARKER_PREFIX}:${marker}]`;
    return (
      `bb: ${label}`
        .slice(0, 120 - suffix.length)
        .replace(/[\uD800-\uDBFF]$/u, "") + suffix
    );
  }

  async function findMappedThread(
    api: KoreyClient,
    marker: string,
    signal?: AbortSignal,
  ): Promise<KoreyThread | null> {
    const token = `${MAPPING_MARKER_PREFIX}:${marker}`;
    const matches: KoreyThread[] = [];
    // Search indexes can tokenize the marker differently. Fall back to an
    // owned-thread scan when search misses, and bound both traversals.
    for (const query of [token, undefined]) {
      let after: string | undefined;
      const cursors = new Set<string>();
      for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
        const page = await api.listThreads({ after, limit: 50, query, signal });
        for (const thread of page.data) {
          if (
            thread.name?.includes(`[${token}]`) &&
            !matches.some((match) => match.id === thread.id)
          )
            matches.push(thread);
        }
        if (!page.has_more || matches.length > 1) break;
        if (page.last_id === null || cursors.has(page.last_id)) {
          throw new Error("Korey thread pagination did not advance");
        }
        if (pageNumber === 19) {
          throw new Error(
            "Korey mapping reconciliation exceeded 20 pages; inspect Korey and link the conversation manually.",
          );
        }
        cursors.add(page.last_id);
        after = page.last_id;
      }
      if (matches.length > 0) break;
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple Korey threads match mapping marker ${marker}; link the intended thread manually.`,
      );
    }
    const match = matches[0] ?? null;
    if (match !== null) assertPrivateThread(match);
    return match;
  }

  async function reconcileMapping(
    api: KoreyClient,
    mapping: MappingRecord,
    signal?: AbortSignal,
  ): Promise<MappingRecord> {
    if (mapping.marker === null) {
      throw new Error(
        `Korey mapping for ${mapping.bbThreadId} requires manual relinking.`,
      );
    }
    const found = await findMappedThread(api, mapping.marker, signal);
    if (found === null) {
      throw new Error(
        `Korey mapping creation for ${mapping.bbThreadId} has an unknown outcome. No exact marker match is visible yet; inspect Korey, then use bb korey link or unlink.`,
      );
    }
    completeMappingCreate(db, {
      bbThreadId: mapping.bbThreadId,
      generation: mapping.generation,
      koreyThreadId: found.id,
    });
    return getMapping(db, mapping.bbThreadId)!;
  }

  async function ensureMapping(
    api: KoreyClient,
    bbThreadId: string,
    signal?: AbortSignal,
    newMappingClaim?: { previousGeneration: number; marker: string },
  ): Promise<{ created: boolean; mapping: MappingRecord }> {
    let mapping = getMapping(db, bbThreadId);
    if (newMappingClaim !== undefined) {
      const claimMatches =
        mapping === null
          ? newMappingClaim.previousGeneration === 0
          : mapping.state === "unlinked"
            ? mapping.generation === newMappingClaim.previousGeneration
            : mapping.marker === newMappingClaim.marker &&
              mapping.generation === newMappingClaim.previousGeneration + 1;
      if (!claimMatches) {
        throw new Error(
          "The Korey destination changed while preparing the request; inspect the linked conversation before trying again.",
        );
      }
    }
    if (mapping?.state === "ready") {
      if (mapping.koreyThreadId === null) {
        throw new Error(`Stored Korey mapping for ${bbThreadId} is invalid`);
      }
      return { created: false, mapping };
    }
    if (
      mapping?.state === "create-dispatching" ||
      mapping?.state === "reconcile-required"
    ) {
      mapping = await reconcileMapping(api, mapping, signal);
      return { created: true, mapping };
    }
    if (mapping === null || mapping.state === "unlinked") {
      mapping = reserveMapping(
        db,
        bbThreadId,
        newMappingClaim?.marker ?? randomUUID(),
      );
    }
    if (
      newMappingClaim !== undefined &&
      (mapping.marker !== newMappingClaim.marker ||
        mapping.generation !== newMappingClaim.previousGeneration + 1)
    ) {
      throw new Error(
        "The Korey destination changed while preparing the request; inspect the linked conversation before trying again.",
      );
    }
    if (mapping.state !== "reserved" || mapping.marker === null) {
      throw new Error(`Stored Korey mapping for ${bbThreadId} is invalid`);
    }
    let name: string;
    try {
      name = await bbThreadName(bbThreadId, mapping.marker);
      signal?.throwIfAborted();
    } catch (error) {
      rejectMappingCreate(db, bbThreadId, mapping.generation, "reserved");
      throw error;
    }
    if (!beginMappingCreate(db, bbThreadId, mapping.generation)) {
      const current = getMapping(db, bbThreadId);
      if (current?.state === "ready" && current.koreyThreadId !== null) {
        return { created: false, mapping: current };
      }
      throw new Error(`Korey mapping for ${bbThreadId} changed concurrently`);
    }
    try {
      const created = await api.createEmptyThread(
        {
          name,
          isPrivate: true,
        },
        signal,
      );
      completeMappingCreate(db, {
        bbThreadId,
        generation: mapping.generation,
        koreyThreadId: created.thread_id,
      });
      return { created: true, mapping: getMapping(db, bbThreadId)! };
    } catch (error) {
      if (mutationWasRejected(error)) {
        rejectMappingCreate(db, bbThreadId, mapping.generation);
        throw error;
      }
      requireMappingReconciliation(db, bbThreadId, mapping.generation);
      try {
        const reconciled = await reconcileMapping(
          api,
          getMapping(db, bbThreadId)!,
          signal,
        );
        return { created: true, mapping: reconciled };
      } catch {
        throw new Error(
          `Korey thread creation has an unknown outcome and will not be retried automatically. Inspect Korey, then link or unlink the conversation. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async function linkThread(
    bbThreadId: string,
    koreyThreadId: string,
    signal?: AbortSignal,
  ): Promise<KoreyThread> {
    return withThreadLock(bbThreadId, async () => {
      assertCanChangeMapping(bbThreadId, koreyThreadId);
      const api = await client();
      const thread = await api.getThread(koreyThreadId, signal);
      assertPrivateThread(thread);
      assertCanChangeMapping(bbThreadId, thread.id);
      setLinkedMapping(db, bbThreadId, thread.id);
      return thread;
    });
  }

  async function unlinkThread(bbThreadId: string): Promise<boolean> {
    return withThreadLock(bbThreadId, async () => {
      assertCanChangeMapping(bbThreadId, null);
      return setUnlinkedMapping(db, bbThreadId);
    });
  }

  function assertCanChangeMapping(
    bbThreadId: string,
    destination: string | null,
  ): void {
    const current = getMapping(db, bbThreadId)?.koreyThreadId ?? null;
    if (current === destination) return;
    const inherited = listUnresolvedOperations(db, bbThreadId, current).filter(
      (operation) => operation.bbThreadId !== bbThreadId,
    );
    if (inherited.length > 0) {
      throw new Error(
        `Recover the unresolved Shortcut operations in this conversation before changing its link: ${inherited.map(({ id }) => id).join(", ")}. Inspect them here with korey_get_operation, then resume, reconcile, or manually resolve them. Changing the link would bypass their recovery safeguards.`,
      );
    }
  }

  async function readAttachments(
    bbThreadId: string,
    paths: readonly string[],
    signal?: AbortSignal,
  ): Promise<PreparedAttachment[]> {
    if (paths.length === 0) return [];
    const thread = await bb.sdk.threads.get({ threadId: bbThreadId });
    if (thread.environmentId === null) {
      throw new Error("File attachments require a thread environment");
    }
    const environment = await bb.sdk.environments.get({
      environmentId: thread.environmentId,
      signal,
    });
    if (environment.path === null) {
      throw new Error("File attachments require a thread workspace");
    }
    const prepared = await Promise.all(
      paths.map(async (path) => {
        const attachment = await host.call(
          "readAttachment",
          { path, workspaceRoot: environment.path! },
          { hostId: environment.hostId, signal },
        );
        const { identity, ...file } = attachment;
        const bytes = Buffer.from(file.base64, "base64");
        return {
          file,
          identity,
          summary: {
            sourcePath: path,
            filename: file.filename,
            contentType: file.contentType,
            size: bytes.length,
            sha256: hash(bytes),
          },
        };
      }),
    );
    const identities = new Set<string>();
    for (const attachment of prepared) {
      if (identities.has(attachment.identity)) {
        throw new Error(
          `Duplicate attachment file: ${attachment.summary.sourcePath}`,
        );
      }
      identities.add(attachment.identity);
    }
    return prepared;
  }

  async function sendConsultation(
    bbThreadId: string,
    prompt: string,
    signal?: AbortSignal,
    paths: readonly string[] = [],
  ): Promise<LinkedThread> {
    const prepared = await readAttachments(bbThreadId, paths, signal);
    return withThreadLock(bbThreadId, async () => {
      const api = await client();
      const linked = await ensureMapping(api, bbThreadId, signal);
      const koreyThreadId = linked.mapping.koreyThreadId;
      if (koreyThreadId === null)
        throw new Error("Korey mapping is incomplete");
      const koreyThread = await api.getThread(koreyThreadId, signal);
      assertPrivateThread(koreyThread);
      if (koreyThread.state !== "ready") {
        throw new Error(
          `Linked Korey thread ${koreyThread.id} is ${koreyThread.state}, not ready`,
        );
      }
      let uploaded: Awaited<ReturnType<KoreyClient["uploadAttachments"]>> = [];
      try {
        uploaded = prepared.length
          ? await api.uploadAttachments(
              koreyThread.id,
              prepared.map(({ file }) => file),
              signal,
            )
          : [];
      } catch (error) {
        const outcome = mutationWasRejected(error)
          ? "Korey rejected the attachment upload."
          : "The attachment upload outcome is unknown and files may consume the conversation quota.";
        throw new Error(
          `${outcome} No consultation message was knowingly sent; inspect Korey before retrying. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const consultationId = `korey-consult-${randomUUID()}`;
      const marker = consultationMarker(consultationId);
      const consultationText = `${CONSULT_PREFIX}${marker}\n\n${prompt.trim()}`;
      const attachmentIds = uploaded.map((file) => file.id);
      let messageId: string;
      try {
        const sent = await api.sendMessage(
          koreyThread.id,
          consultationText,
          signal,
          attachmentIds,
        );
        messageId = sent.message_id;
      } catch (error) {
        if (mutationWasRejected(error)) {
          throw new Error(
            `Korey rejected consultation ${consultationId} before accepting it. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        let reconciledMessageId: string | null;
        try {
          reconciledMessageId = await findMessageByRequest(
            api,
            koreyThread.id,
            consultationText,
            attachmentIds,
            signal,
          );
        } catch (reconcileError) {
          throw new Error(
            `Korey consultation ${consultationId} has an unknown dispatch outcome and reconciliation failed. Inspect the linked thread; do not resend automatically. ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`,
          );
        }
        if (reconciledMessageId === null) {
          throw new Error(
            `Korey consultation ${consultationId} has an unknown dispatch outcome and no exact history match is visible. Inspect the linked thread; do not resend automatically. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        messageId = reconciledMessageId;
      }
      let messages: KoreyMessage[];
      try {
        messages = await api.waitForResponse(koreyThread.id, messageId, signal);
      } catch (error) {
        throw new Error(
          `Korey accepted consultation ${consultationId} as message ${messageId}, but response polling did not complete. Inspect the linked thread instead of resending automatically. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const response = boundedText(formatKoreyMessages(messages));
      return {
        created: linked.created,
        koreyThread,
        responseText: response.text,
        responseTruncated: response.truncated,
      };
    });
  }

  function mappingDestination(bbThreadId: string) {
    const mapping = getMapping(db, bbThreadId);
    if (mapping === null) {
      return {
        kind: "new-private-thread" as const,
        koreyThreadId: null,
        koreyThreadRevision: null,
        mappingGeneration: 0,
      };
    }
    if (mapping.state === "unlinked") {
      return {
        kind: "new-private-thread" as const,
        koreyThreadId: null,
        koreyThreadRevision: null,
        mappingGeneration: mapping.generation,
      };
    }
    if (mapping.state === "ready" && mapping.koreyThreadId !== null) {
      return {
        kind: "linked-private-thread" as const,
        koreyThreadId: mapping.koreyThreadId,
        koreyThreadRevision: null,
        mappingGeneration: mapping.generation,
      };
    }
    throw new Error(
      `The Korey mapping for this bb thread is ${mapping.state}. Reconcile it with bb korey link or unlink before requesting a Shortcut write.`,
    );
  }

  async function requestDestination(
    api: KoreyClient,
    bbThreadId: string,
    signal?: AbortSignal,
  ) {
    const destination = mappingDestination(bbThreadId);
    if (destination.kind === "new-private-thread") return destination;
    const thread = await api.getThread(destination.koreyThreadId, signal);
    assertPrivateThread(thread);
    if (thread.state !== "ready") {
      throw new Error(
        `Linked Korey thread ${thread.id} is ${thread.state}, not ready. Wait for Korey to finish or link a ready conversation before sending the request.`,
      );
    }
    return { ...destination, koreyThreadRevision: thread.updated_at };
  }

  function mappingStillMatches(request: ShortcutRequest): boolean {
    const mapping = getMapping(db, request.bbThreadId);
    if (request.destination.kind === "new-private-thread") {
      return mapping === null
        ? request.destination.mappingGeneration === 0
        : mapping.state === "unlinked" &&
            mapping.generation === request.destination.mappingGeneration;
    }
    return (
      mapping?.state === "ready" &&
      mapping.generation === request.destination.mappingGeneration &&
      mapping.koreyThreadId === request.destination.koreyThreadId
    );
  }

  function requestMappingMatches(
    request: ShortcutRequest,
    mapping: MappingRecord,
  ): boolean {
    if (request.destination.kind === "new-private-thread") {
      return (
        mapping.state === "ready" &&
        mapping.koreyThreadId !== null &&
        mapping.marker === request.operationId &&
        mapping.generation === request.destination.mappingGeneration + 1
      );
    }
    return (
      mapping.state === "ready" &&
      mapping.generation === request.destination.mappingGeneration &&
      mapping.koreyThreadId === request.destination.koreyThreadId
    );
  }

  function assertNoUnresolvedOperations(
    bbThreadId: string,
    koreyThreadId: string | null,
  ): void {
    const unresolved = listUnresolvedOperations(db, bbThreadId, koreyThreadId);
    const [first] = unresolved;
    if (first !== undefined) {
      const details = unresolved
        .map(
          (operation) =>
            `${operation.id} (${operation.status}, originating bb thread ${operation.bbThreadId})`,
        )
        .join(", ");
      throw new Error(
        `An earlier Shortcut operation is unresolved: ${details}. This request was not sent. Inspect it here with korey_get_operation, or use bb korey operation show ${first.id} --bb-thread ${first.bbThreadId}, then resume or reconcile it. If the outcome remains unknown, ask the user before using bb korey operation resolve; do not submit a replacement automatically.`,
      );
    }
  }

  function shortcutPrompt(
    request: Pick<
      ShortcutRequest,
      "action" | "operationId" | "storyId" | "instruction"
    >,
    legacyApproval = false,
  ): string {
    const authorization = legacyApproval
      ? "The user approved this external write through bb's confirmation UI."
      : "The user requested this Shortcut change from bb.";
    return request.action === "create"
      ? [
          authorization,
          operationMarker(request.operationId, legacyApproval),
          "Create exactly one Shortcut Story in the connected workspace.",
          "Return the created Story ID and URL. Do not create a duplicate if this operation reference already appears in the conversation.",
          "",
          request.instruction,
        ].join("\n")
      : [
          authorization,
          operationMarker(request.operationId, legacyApproval),
          `Update Shortcut Story ${request.storyId}.`,
          "Preserve unrelated fields. Return the Story ID, URL, and fields changed.",
          "",
          request.instruction,
        ].join("\n");
  }

  function storedOperationPrompt(operation: OperationRecord): string {
    if (operation.dispatchedText !== null) return operation.dispatchedText;
    // Original journals predate dispatched_text. Preserve the version 1 prompt
    // and validate only the fields it used, independent of today's approval UI.
    const legacy = z
      .object({
        operationId: z.string(),
        action: z.enum(["create", "update"]),
        storyId: z.string().nullable(),
        instruction: z.string(),
      })
      .safeParse(operation.request);
    if (operation.requestVersion !== 1 || !legacy.success) {
      throw new Error(
        "This operation has no recorded message text and its request version cannot be reconciled by this plugin. Inspect Korey and Shortcut, then use operation resolve.",
      );
    }
    return shortcutPrompt(legacy.data, true);
  }

  function messageMatchesRequest(
    message: KoreyMessage,
    expectedText: string,
    expectedAttachmentIds: readonly string[],
  ): boolean {
    if (message.role !== "user") return false;
    const text = message.contents.filter((content) => content.type === "text");
    if (text.length !== 1 || text[0]?.text !== expectedText) return false;
    const attachmentIds = message.contents.flatMap((content) =>
      content.type === "image" || content.type === "document"
        ? [content.attachment_id]
        : [],
    );
    return (
      message.contents.length === 1 + attachmentIds.length &&
      attachmentIds.length === expectedAttachmentIds.length &&
      expectedAttachmentIds.every((id) => attachmentIds.includes(id))
    );
  }

  async function findMessageByRequest(
    api: KoreyClient,
    koreyThreadId: string,
    expectedText: string,
    expectedAttachmentIds: readonly string[],
    signal?: AbortSignal,
  ): Promise<string | null> {
    const messages = await api.listAllMessages(koreyThreadId, signal);
    const matches = messages.filter((message) =>
      messageMatchesRequest(message, expectedText, expectedAttachmentIds),
    );
    if (matches.length > 1) {
      throw new Error(
        "Korey conversation contains multiple exact copies of the request; inspect it manually.",
      );
    }
    return matches[0]?.id ?? null;
  }

  async function findOperationMessage(
    api: KoreyClient,
    operation: OperationRecord,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (operation.koreyThreadId === null) return null;
    return findMessageByRequest(
      api,
      operation.koreyThreadId,
      storedOperationPrompt(operation),
      operation.attachmentIds,
      signal,
    );
  }

  async function finishOperationPolling(
    api: KoreyClient,
    operation: OperationRecord,
    signal?: AbortSignal,
  ): Promise<OperationRecord> {
    if (
      operation.status !== "awaiting-response" ||
      operation.koreyThreadId === null ||
      operation.koreyMessageId === null
    ) {
      throw new Error(
        `Korey operation ${operation.id} cannot resume response polling from ${operation.status}.`,
      );
    }
    try {
      const messages = await api.waitForResponse(
        operation.koreyThreadId,
        operation.koreyMessageId,
        signal,
      );
      const response = boundedText(formatKoreyMessages(messages));
      return transitionOperation(db, {
        id: operation.id,
        from: "awaiting-response",
        to: "korey-complete",
        patch: {
          completedAt: Date.now(),
          error: null,
          responseText: response.text,
          responseTruncated: response.truncated,
        },
      });
    } catch (error) {
      updateOperationError(
        db,
        operation.id,
        `Response polling can be resumed safely: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new Error(
        `Korey accepted operation ${operation.id}, but response polling did not complete. Use korey_resume_operation or bb korey operation resume ${operation.id}; do not submit a new Shortcut request.`,
      );
    }
  }

  async function executeShortcutOperation(
    api: KoreyClient,
    operation: OperationRecord,
    request: ShortcutRequest,
    prepared: readonly PreparedAttachment[],
    signal?: AbortSignal,
  ): Promise<OperationRecord> {
    transitionOperation(db, {
      id: operation.id,
      from: "requested",
      to: "preparing",
      patch: { error: null },
    });

    let linked: Awaited<ReturnType<typeof ensureMapping>>;
    let koreyThread: KoreyThread;
    try {
      linked = await ensureMapping(
        api,
        operation.bbThreadId,
        signal,
        request.destination.kind === "new-private-thread"
          ? {
              previousGeneration: request.destination.mappingGeneration,
              marker: operation.id,
            }
          : undefined,
      );
      if (!requestMappingMatches(request, linked.mapping)) {
        throw new Error(
          "The Korey destination changed while preparing the request; inspect the linked conversation before trying again.",
        );
      }
      if (linked.mapping.koreyThreadId === null) {
        throw new Error("Korey mapping is incomplete");
      }
      transitionOperation(db, {
        id: operation.id,
        from: "preparing",
        to: "preparing",
        patch: { koreyThreadId: linked.mapping.koreyThreadId },
      });
      koreyThread = await api.getThread(linked.mapping.koreyThreadId, signal);
      assertPrivateThread(koreyThread);
      if (
        request.destination.kind === "linked-private-thread" &&
        koreyThread.updated_at !== request.destination.koreyThreadRevision
      ) {
        throw new Error(
          "The Korey conversation changed while preparing the request; inspect it before trying again.",
        );
      }
      if (koreyThread.state !== "ready") {
        throw new Error(
          `Linked Korey thread ${koreyThread.id} is ${koreyThread.state}, not ready`,
        );
      }
    } catch (error) {
      transitionOperation(db, {
        id: operation.id,
        from: "preparing",
        to: "definite-failure",
        patch: {
          error: `No Shortcut message was dispatched. ${error instanceof Error ? error.message : String(error)}`,
        },
      });
      throw new Error(
        `Korey operation ${operation.id} stopped before sending a Shortcut message. Resolve the error before trying again. ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    transitionOperation(db, {
      id: operation.id,
      from: "preparing",
      to: "thread-ready",
      patch: { koreyThreadId: koreyThread.id },
    });

    let attachmentIds: string[] = [];
    if (prepared.length > 0) {
      transitionOperation(db, {
        id: operation.id,
        from: "thread-ready",
        to: "attachment-upload-dispatching",
      });
      try {
        const uploaded = await api.uploadAttachments(
          koreyThread.id,
          prepared.map(({ file }) => file),
          signal,
        );
        attachmentIds = uploaded.map((file) => file.id);
      } catch (error) {
        transitionOperation(db, {
          id: operation.id,
          from: "attachment-upload-dispatching",
          to: "definite-failure",
          patch: {
            error: `No Shortcut message was dispatched. Attachment upload outcome may be unknown. ${error instanceof Error ? error.message : String(error)}`,
          },
        });
        throw new Error(
          `Korey operation ${operation.id} sent no Shortcut message because attachment upload did not complete. Uploaded files may still consume the thread quota; inspect Korey before starting another operation.`,
        );
      }
      transitionOperation(db, {
        id: operation.id,
        from: "attachment-upload-dispatching",
        to: "attachments-uploaded",
        patch: { attachmentIds },
      });
    } else {
      transitionOperation(db, {
        id: operation.id,
        from: "thread-ready",
        to: "attachments-uploaded",
        patch: { attachmentIds: [] },
      });
    }

    // Recovery in a previous bb thread can change this conversation's journal
    // while preparation awaits Korey, outside the current bb-thread lock.
    try {
      assertNoUnresolvedOperations(operation.bbThreadId, koreyThread.id);
      signal?.throwIfAborted();
    } catch (error) {
      transitionOperation(db, {
        id: operation.id,
        from: "attachments-uploaded",
        to: "definite-failure",
        patch: {
          error: `No Shortcut message was dispatched. ${error instanceof Error ? error.message : String(error)}`,
        },
      });
      throw error;
    }
    const dispatchedText = shortcutPrompt(request);
    transitionOperation(db, {
      id: operation.id,
      from: "attachments-uploaded",
      to: "message-dispatching",
      patch: { dispatchedText },
    });
    try {
      const sent = await api.sendMessage(
        koreyThread.id,
        dispatchedText,
        signal,
        attachmentIds,
      );
      operation = transitionOperation(db, {
        id: operation.id,
        from: "message-dispatching",
        to: "awaiting-response",
        patch: { koreyMessageId: sent.message_id },
      });
    } catch (error) {
      if (mutationWasRejected(error)) {
        transitionOperation(db, {
          id: operation.id,
          from: "message-dispatching",
          to: "definite-failure",
          patch: {
            error: `Korey rejected the Shortcut message before accepting it. ${error instanceof Error ? error.message : String(error)}`,
          },
        });
        throw new Error(
          `Korey rejected operation ${operation.id}; no Shortcut-intended message was accepted. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      operation = transitionOperation(db, {
        id: operation.id,
        from: "message-dispatching",
        to: "reconcile-required",
        patch: {
          error: `Message dispatch outcome is unknown. ${error instanceof Error ? error.message : String(error)}`,
        },
      });
      try {
        const messageId = await findOperationMessage(api, operation, signal);
        if (messageId !== null) {
          operation = transitionOperation(db, {
            id: operation.id,
            from: "reconcile-required",
            to: "awaiting-response",
            patch: { error: null, koreyMessageId: messageId },
          });
        }
      } catch (reconcileError) {
        updateOperationError(
          db,
          operation.id,
          `Message dispatch and reconciliation are unresolved. ${reconcileError instanceof Error ? reconcileError.message : String(reconcileError)}`,
        );
      }
      if (operation.status !== "awaiting-response") {
        throw new Error(
          `Korey operation ${operation.id} has an unknown Shortcut outcome. Use korey_reconcile_operation or bb korey operation reconcile ${operation.id}; never submit a replacement automatically.`,
        );
      }
    }
    return finishOperationPolling(api, operation, signal);
  }

  async function applyShortcutChange(
    bbThreadId: string,
    input: ShortcutChangeInput,
    signal?: AbortSignal,
  ): Promise<OperationRecord> {
    const storyId =
      input.action === "update" && input.storyId !== undefined
        ? normalizeStoryId(input.storyId)
        : null;
    if (input.action === "update" && storyId === null) {
      throw new Error(
        `Invalid Shortcut story ID ${JSON.stringify(input.storyId)}`,
      );
    }
    return withThreadLock(bbThreadId, async () => {
      signal?.throwIfAborted();
      const currentDestination = mappingDestination(bbThreadId);
      assertNoUnresolvedOperations(
        bbThreadId,
        currentDestination.koreyThreadId,
      );
      const api = await client();
      const [prepared, identity, destination] = await Promise.all([
        readAttachments(bbThreadId, input.files ?? [], signal),
        api.identity(signal),
        requestDestination(api, bbThreadId, signal),
      ]);
      signal?.throwIfAborted();
      const unsigned = {
        operationId: `korey-${randomUUID()}`,
        bbThreadId,
        action: input.action,
        storyId,
        instruction: input.instruction.trim(),
        koreyOrganization: identity.korey_organization_slug,
        destination,
        attachments: prepared.map(({ summary }) => summary),
      };
      const request = shortcutRequestSchema.parse({
        ...unsigned,
        requestHash: hash(JSON.stringify(unsigned)),
      });
      if (!mappingStillMatches(request)) {
        throw new Error(
          "The Korey destination changed while preparing the request. Inspect the linked conversation before trying again.",
        );
      }
      assertNoUnresolvedOperations(bbThreadId, destination.koreyThreadId);
      const operation = createOperation(db, request);
      return executeShortcutOperation(
        api,
        operation,
        request,
        prepared,
        signal,
      );
    });
  }

  function operationForThread(
    bbThreadId: string,
    operationId: string,
  ): OperationRecord {
    const operation = getOperation(db, operationId);
    const destination = getMapping(db, bbThreadId)?.koreyThreadId ?? null;
    if (
      operation === null ||
      (operation.bbThreadId !== bbThreadId &&
        (destination === null || operation.koreyThreadId !== destination))
    ) {
      throw new Error(`Unknown Korey operation ${operationId}`);
    }
    return operation;
  }

  function operationsForThread(
    bbThreadId: string,
    limit: number,
  ): OperationRecord[] {
    return listOperations(
      db,
      bbThreadId,
      limit,
      getMapping(db, bbThreadId)?.koreyThreadId ?? null,
    );
  }

  async function withOperationLock<T>(
    bbThreadId: string,
    operationId: string,
    run: (operation: OperationRecord) => Promise<T>,
  ): Promise<T> {
    const operation = operationForThread(bbThreadId, operationId);
    // Relinked and originating threads must serialize recovery of the same row.
    return withThreadLock(operation.bbThreadId, async () =>
      run(operationForThread(bbThreadId, operationId)),
    );
  }

  async function resumeOperation(
    bbThreadId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<OperationRecord> {
    return withOperationLock(bbThreadId, operationId, async (operation) => {
      if (operation.status === "korey-complete") return operation;
      return finishOperationPolling(await client(), operation, signal);
    });
  }

  async function reconcileOperation(
    bbThreadId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<{ reconciled: boolean; operation: OperationRecord }> {
    return withOperationLock(bbThreadId, operationId, async (current) => {
      let operation = current;
      if (operation.status === "korey-complete") {
        return { reconciled: true, operation };
      }
      if (operation.status === "awaiting-response") {
        operation = await finishOperationPolling(
          await client(),
          operation,
          signal,
        );
        return { reconciled: true, operation };
      }
      if (operation.status !== "reconcile-required") {
        throw new Error(
          `Korey operation ${operation.id} is ${operation.status}, not reconcile-required.`,
        );
      }
      const api = await client();
      const messageId = await findOperationMessage(api, operation, signal);
      if (messageId === null) {
        operation = updateOperationError(
          db,
          operation.id,
          "No matching Korey message is visible. This does not prove the original dispatch failed; inspect Korey and Shortcut before any replacement.",
        );
        return { reconciled: false, operation };
      }
      operation = transitionOperation(db, {
        id: operation.id,
        from: "reconcile-required",
        to: "awaiting-response",
        patch: { error: null, koreyMessageId: messageId },
      });
      operation = await finishOperationPolling(api, operation, signal);
      return { reconciled: true, operation };
    });
  }

  async function resolveOperation(
    bbThreadId: string,
    operationId: string,
    note: string,
    signal?: AbortSignal,
  ): Promise<OperationRecord> {
    const operation = operationForThread(bbThreadId, operationId);
    if (
      operation.status !== "awaiting-response" &&
      operation.status !== "reconcile-required"
    ) {
      throw new Error(
        `Korey operation ${operation.id} is ${operation.status}; only unresolved operations can be manually resolved.`,
      );
    }
    const resolutionHash = (current: OperationRecord) =>
      hash(JSON.stringify({ operation: current, note: note.trim() }));
    const payload = operationResolutionPayloadSchema.parse({
      operationId: operation.id,
      resolutionHash: resolutionHash(operation),
      status: operation.status,
      instruction: storedRequestSummarySchema.parse(operation.request)
        .instruction,
      koreyThreadId: operation.koreyThreadId,
      note,
    });
    const interaction = await bb.ui.requestInput(
      {
        threadId: bbThreadId,
        rendererId: OPERATION_RESOLUTION_RENDERER_ID,
        title: "Resolve Korey operation manually",
        payload,
        timeoutMs: INTERACTION_TIMEOUT_MS,
      },
      { signal },
    );
    if (interaction.outcome === "cancelled") {
      throw new Error(
        `Operation resolution cancelled (${interaction.reason}); the operation remains unresolved.`,
      );
    }
    const response = operationResolutionResponseSchema.safeParse(
      interaction.value,
    );
    if (
      !response.success ||
      response.data.operationId !== payload.operationId ||
      response.data.resolutionHash !== payload.resolutionHash
    ) {
      throw new Error(
        "Operation resolution was not confirmed for this operation and note.",
      );
    }
    return withOperationLock(bbThreadId, operationId, async (current) => {
      if (resolutionHash(current) !== payload.resolutionHash) {
        throw new Error(
          "The operation changed while resolution was pending. Inspect it again before resolving.",
        );
      }
      return transitionOperation(db, {
        id: operationId,
        from: operation.status,
        to: "manually-resolved",
        patch: { resolutionNote: payload.note, completedAt: Date.now() },
      });
    });
  }

  bb.cli.register({
    name: "korey",
    summary: "Ask Korey to work with your connected tools",
    commands: CLI_COMMANDS,
    async run(argv, context) {
      const [command, ...rest] = argv;
      if (command === undefined || command === "help" || command === "--help") {
        return { exitCode: 0, stdout: usage() };
      }
      try {
        const parsed = parseCommonCliArgs(rest);
        if (command === "status") {
          if (
            parsed.positional.length > 0 ||
            parsed.bbThreadId !== undefined ||
            parsed.files.length > 0 ||
            parsed.after !== undefined ||
            parsed.limit !== undefined
          ) {
            throw new Error("status accepts only --json");
          }
          const identity = await (await client()).identity(context.signal);
          return cliOutput(
            parsed.json,
            identity,
            `Authenticated as ${identity.name ?? identity.email ?? identity.sub} in ${identity.korey_organization_slug}.`,
          );
        }
        if (command === "threads") {
          if (parsed.bbThreadId !== undefined || parsed.files.length > 0) {
            throw new Error("threads does not accept --bb-thread or --file");
          }
          const page = await (
            await client()
          ).listThreads({
            after: parsed.after,
            limit: parsed.limit,
            query: parsed.positional.join(" "),
            signal: context.signal,
          });
          return cliOutput(parsed.json, page, plainThreadList(page.data));
        }
        if (command === "show") {
          if (
            parsed.positional.length !== 1 ||
            parsed.bbThreadId !== undefined ||
            parsed.files.length > 0
          ) {
            throw new Error("show requires exactly one Korey thread ID");
          }
          const api = await client();
          const threadId = parsed.positional[0]!;
          const [thread, messages] = await Promise.all([
            api.getThread(threadId, context.signal),
            api.listMessages(threadId, {
              after: parsed.after,
              limit: parsed.limit,
              signal: context.signal,
            }),
          ]);
          const value = { thread, messages };
          return cliOutput(
            parsed.json,
            value,
            plainConversation(thread, messages.data, messages.has_more),
          );
        }
        if (command === "link") {
          if (
            parsed.positional.length !== 1 ||
            parsed.files.length > 0 ||
            parsed.after !== undefined ||
            parsed.limit !== undefined
          ) {
            throw new Error("link requires exactly one Korey thread ID");
          }
          const bbThreadId = cliThreadId(parsed.bbThreadId, context.threadId);
          const thread = await linkThread(
            bbThreadId,
            parsed.positional[0]!,
            context.signal,
          );
          const value = { bbThreadId, koreyThread: thread };
          return cliOutput(
            parsed.json,
            value,
            `Linked bb thread ${bbThreadId} to ${thread.name ?? thread.id}.`,
          );
        }
        if (command === "unlink") {
          if (
            parsed.positional.length > 0 ||
            parsed.files.length > 0 ||
            parsed.after !== undefined ||
            parsed.limit !== undefined
          ) {
            throw new Error("unlink accepts only --bb-thread and --json");
          }
          const bbThreadId = cliThreadId(parsed.bbThreadId, context.threadId);
          const removed = await unlinkThread(bbThreadId);
          const value = { bbThreadId, removed };
          return cliOutput(
            parsed.json,
            value,
            removed
              ? `Removed the Korey link for bb thread ${bbThreadId}.`
              : `bb thread ${bbThreadId} had no Korey link.`,
          );
        }
        if (command === "ask") {
          if (
            parsed.positional.length === 0 ||
            parsed.after !== undefined ||
            parsed.limit !== undefined
          ) {
            throw new Error("ask requires a message");
          }
          const bbThreadId = cliThreadId(parsed.bbThreadId, context.threadId);
          const result = await sendConsultation(
            bbThreadId,
            parsed.positional.join(" "),
            context.signal,
            parsed.files,
          );
          const value = {
            created: result.created,
            koreyThreadId: result.koreyThread.id,
            appUrl: result.koreyThread.app_url,
            response: result.responseText,
            responseTruncated: result.responseTruncated,
          };
          return cliOutput(
            parsed.json,
            value,
            `${result.responseText}\n\n${result.koreyThread.app_url}`,
          );
        }
        if (command === "shortcut") {
          if (parsed.after !== undefined || parsed.limit !== undefined) {
            throw new Error("shortcut does not accept --after or --limit");
          }
          const [action, ...actionArgs] = parsed.positional;
          if (action !== "create" && action !== "update") {
            throw new Error("shortcut requires create or update");
          }
          const bbThreadId = cliThreadId(parsed.bbThreadId, context.threadId);
          let storyId: string | undefined;
          let instruction: string;
          if (action === "update") {
            storyId = actionArgs[0];
            instruction = actionArgs.slice(1).join(" ").trim();
            if (storyId === undefined || instruction.length === 0) {
              throw new Error(
                "shortcut update requires a Story ID and instruction",
              );
            }
          } else {
            instruction = actionArgs.join(" ").trim();
            if (instruction.length === 0) {
              throw new Error("shortcut create requires an instruction");
            }
          }
          const operation = await applyShortcutChange(
            bbThreadId,
            {
              action,
              instruction,
              storyId,
              ...(parsed.files.length > 0 ? { files: parsed.files } : {}),
            },
            context.signal,
          );
          const value = operationView(operation);
          return cliOutput(
            parsed.json,
            value,
            `Operation ${operation.id} (${operation.status})\n\n${operation.responseText ?? "No response recorded."}`,
          );
        }
        if (command === "operation") {
          if (parsed.files.length > 0 || parsed.after !== undefined) {
            throw new Error("operation does not accept --file or --after");
          }
          const [action, operationId, ...extra] = parsed.positional;
          const bbThreadId = cliThreadId(parsed.bbThreadId, context.threadId);
          if (action === "resolve") {
            if (
              operationId === undefined ||
              extra.length === 0 ||
              parsed.limit !== undefined
            ) {
              throw new Error(
                "operation resolve requires an operation ID and a resolution note",
              );
            }
            const operation = await resolveOperation(
              bbThreadId,
              operationId,
              extra.join(" "),
              context.signal,
            );
            return cliOutput(
              parsed.json,
              operationView(operation),
              `Operation ${operation.id} was manually resolved. ${operation.resolutionNote}`,
            );
          }
          if (action === "list") {
            if (operationId !== undefined || extra.length > 0) {
              throw new Error("operation list accepts no operation ID");
            }
            const operations = operationsForThread(
              bbThreadId,
              parsed.limit ?? 20,
            ).map(operationView);
            return cliOutput(
              parsed.json,
              operations,
              operations.length === 0
                ? "No Korey operations found."
                : operations
                    .map(
                      (operation) =>
                        `${operation.operationId}\t${operation.status}\t${operation.action}\t${operation.storyId ?? "new Story"}`,
                    )
                    .join("\n"),
            );
          }
          if (
            (action !== "show" &&
              action !== "resume" &&
              action !== "reconcile") ||
            operationId === undefined ||
            extra.length > 0 ||
            parsed.limit !== undefined
          ) {
            throw new Error(
              "operation requires list, show <id>, resume <id>, reconcile <id>, or resolve <id> <note>",
            );
          }
          if (action === "show") {
            const operation = operationForThread(bbThreadId, operationId);
            return cliOutput(
              parsed.json,
              operationView(operation),
              JSON.stringify(operationView(operation), null, 2),
            );
          }
          if (action === "resume") {
            const operation = await resumeOperation(
              bbThreadId,
              operationId,
              context.signal,
            );
            return cliOutput(
              parsed.json,
              operationView(operation),
              `Operation ${operation.id} is ${operation.status}.`,
            );
          }
          const result = await reconcileOperation(
            bbThreadId,
            operationId,
            context.signal,
          );
          return cliOutput(
            parsed.json,
            {
              reconciled: result.reconciled,
              ...operationView(result.operation),
            },
            result.reconciled
              ? `Operation ${result.operation.id} reconciled as ${result.operation.status}.`
              : `Operation ${result.operation.id} remains unresolved; inspect Korey and Shortcut.`,
          );
        }
        throw new Error(
          `Unknown command ${JSON.stringify(command)}\n${usage()}`,
        );
      } catch (error) {
        const message =
          error instanceof Error &&
          "code" in error &&
          error.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION"
            ? "Unknown option. See bb korey --help for supported options. Use -- before positional text starting with a dash."
            : error instanceof Error
              ? error.message
              : String(error);
        return {
          exitCode: 1,
          stderr: `${message}\n`,
        };
      }
    },
  });

  bb.agents.registerTool({
    name: "korey_status",
    description:
      "Check the configured Korey identity and organization without changing anything.",
    parameters: z.object({}).strict(),
    async execute(_input, context) {
      return executeJsonTool(async () =>
        (await client()).identity(context.signal),
      );
    },
  });

  bb.agents.registerTool({
    name: "korey_list_threads",
    description: "List the authenticated user's owned Korey threads.",
    parameters: z
      .object({
        query: z.string().optional(),
        after: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(20),
      })
      .strict(),
    async execute({ query, after, limit }, context) {
      return executeJsonTool(async () =>
        (await client()).listThreads({
          query,
          after,
          limit,
          signal: context.signal,
        }),
      );
    },
  });

  bb.agents.registerTool({
    name: "korey_get_thread",
    description: "Read a Korey thread and one paginated message page.",
    parameters: z
      .object({
        threadId: z.string().min(1),
        after: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(200),
      })
      .strict(),
    async execute({ threadId, after, limit }, context) {
      return executeJsonTool(async () => {
        const api = await client();
        const [thread, messages] = await Promise.all([
          api.getThread(threadId, context.signal),
          api.listMessages(threadId, {
            after,
            limit,
            signal: context.signal,
          }),
        ]);
        return { thread, messages };
      });
    },
  });

  bb.agents.registerTool({
    name: "korey_link_thread",
    description:
      "Link an existing private Korey thread to the current bb thread so future requests continue it.",
    parameters: z.object({ koreyThreadId: z.string().min(1) }).strict(),
    async execute({ koreyThreadId }, context) {
      return executeJsonTool(async () => ({
        bbThreadId: context.threadId,
        koreyThread: await linkThread(
          context.threadId,
          koreyThreadId,
          context.signal,
        ),
      }));
    },
  });

  bb.agents.registerTool({
    name: "korey_unlink_thread",
    description:
      "Remove the Korey conversation link for the current bb thread without changing the remote Korey thread.",
    parameters: z.object({}).strict(),
    async execute(_input, context) {
      return executeJsonTool(async () => ({
        bbThreadId: context.threadId,
        removed: await unlinkThread(context.threadId),
      }));
    },
  });

  bb.agents.registerTool({
    name: "korey_ask",
    description:
      "Ask Korey to research connected tools, answer questions, or prepare drafts using its existing connector access. Continues the private Korey conversation linked to this bb thread. The plugin instructs Korey not to modify connected systems.",
    instructions:
      'For "Ask Korey ..." research and drafting requests, delegate the desired outcome and relevant context to Korey. It uses the services connected in Korey, such as Shortcut, Sentry, and LaunchDarkly. Use korey_shortcut_change for Shortcut Story creation or updates; that tool sends the user’s requested change directly. The consultation restriction is a prompt instruction, not a connector permission boundary.',
    parameters: z
      .object({
        prompt: z.string().trim().min(1).max(20_000),
        files: filePathsSchema
          .optional()
          .describe(
            "Supported files in this thread's workspace. Paths are relative to its working directory. Up to 5 files.",
          ),
      })
      .strict(),
    async execute({ prompt, files }, context) {
      return executeJsonTool(async () => {
        const result = await sendConsultation(
          context.threadId,
          prompt,
          context.signal,
          files,
        );
        return {
          created: result.created,
          koreyThreadId: result.koreyThread.id,
          appUrl: result.koreyThread.app_url,
          response: result.responseText,
          responseTruncated: result.responseTruncated,
        };
      });
    },
  });

  bb.agents.registerTool({
    name: "korey_shortcut_change",
    description:
      "Ask Korey to create or update a Shortcut Story using its connector and workspace conventions. An explicit user request authorizes the change; no extra confirmation form is shown.",
    instructions:
      "Call only when the user requested the exact Shortcut create or update. The user’s explicit request is sufficient authorization. Ask for clarification only if the intended change or destination is unclear. Never retry an operation with an unknown outcome by calling this tool again. Inspect it with korey_get_operation, then use korey_resume_operation or korey_reconcile_operation when applicable.",
    parameters: shortcutChangeInputSchema,
    async execute(input, context) {
      return executeJsonTool(async () =>
        operationView(
          await applyShortcutChange(context.threadId, input, context.signal),
        ),
      );
    },
  });

  bb.agents.registerTool({
    name: "korey_list_operations",
    description:
      "List recent Korey Shortcut operations from this bb thread or its linked Korey conversation.",
    parameters: z
      .object({ limit: z.number().int().min(1).max(50).default(20) })
      .strict(),
    async execute({ limit }, context) {
      return executeJsonTool(async () =>
        operationsForThread(context.threadId, limit).map(operationView),
      );
    },
  });

  bb.agents.registerTool({
    name: "korey_get_operation",
    description:
      "Inspect one Korey Shortcut operation without sending or retrying it.",
    parameters: z.object({ operationId: z.string().min(1) }).strict(),
    async execute({ operationId }, context) {
      return executeJsonTool(async () =>
        operationView(operationForThread(context.threadId, operationId)),
      );
    },
  });

  bb.agents.registerTool({
    name: "korey_resume_operation",
    description:
      "Resume safe read-only response polling for a Korey operation whose message ID was already recorded. This never resends a write request.",
    parameters: z.object({ operationId: z.string().min(1) }).strict(),
    async execute({ operationId }, context) {
      return executeJsonTool(async () =>
        operationView(
          await resumeOperation(context.threadId, operationId, context.signal),
        ),
      );
    },
  });

  bb.agents.registerTool({
    name: "korey_reconcile_operation",
    description:
      "Read the linked Korey conversation to reconcile an ambiguous message dispatch. This never resends the request.",
    parameters: z.object({ operationId: z.string().min(1) }).strict(),
    async execute({ operationId }, context) {
      return executeJsonTool(async () => {
        const result = await reconcileOperation(
          context.threadId,
          operationId,
          context.signal,
        );
        return {
          reconciled: result.reconciled,
          ...operationView(result.operation),
        };
      });
    },
  });

  bb.agents.configure(() => ({
    tools: [
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
    ],
    skills: ["korey"],
    instructions:
      'Korey brings its connected services to every bb harness. For "Ask Korey ..." requests, delegate the user’s goal and context to Korey. Use korey_ask for connector research, analysis, and drafts, and korey_shortcut_change for user-requested Shortcut Story creation or updates. Connector setup and reauthentication happen in Korey. Consultation is prompt-mediated; other connector writes are not supported by this plugin. Never replace or automatically retry an ambiguous operation; inspect, resume, or reconcile its existing operation ID.',
  }));
}
