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
  SHORTCUT_APPROVAL_RENDERER_ID,
  shortcutApprovalPayloadSchema,
  shortcutApprovalResponseSchema,
  type ShortcutApprovalPayload,
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
  type OperationStatus,
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
    summary: "Ask Korey for consultation or a draft",
    usage:
      "bb korey ask <message...> [--file <path> ...] [--bb-thread <id>] [--json]",
  },
  {
    name: "shortcut",
    summary: "Request an interactively approved Shortcut create or update",
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
        "Files to bind to the approval and send with the Shortcut request. Paths are relative to this thread's workspace. Up to 5 files.",
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
    text: `${prefix}\n\n[Response truncated by bb-plugin-korey]`,
    truncated: true,
  };
}

function operationView(operation: OperationRecord) {
  return {
    operationId: operation.id,
    status: operation.status,
    action: operation.request.action,
    storyId: operation.request.storyId,
    instruction: operation.request.instruction,
    attachments: operation.request.attachments,
    koreyOrganization: operation.request.koreyOrganization,
    koreyThreadId: operation.koreyThreadId,
    koreyMessageId: operation.koreyMessageId,
    attachmentIds: operation.attachmentIds,
    response: operation.responseText,
    responseTruncated: operation.responseTruncated,
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

function unresolvedOperationSummaries(
  db: ReturnType<BbPluginApi["storage"]["database"]>,
  bbThreadId: string,
  koreyThreadId: string | null,
): ShortcutApprovalPayload["unresolvedOperations"] {
  return listUnresolvedOperations(db, bbThreadId, koreyThreadId).map(
    (operation) => {
      if (
        operation.status !== "awaiting-response" &&
        operation.status !== "reconcile-required"
      ) {
        throw new Error(
          `Unexpected unresolved operation status ${operation.status}`,
        );
      }
      return {
        operationId: operation.id,
        status: operation.status,
        action: operation.request.action,
        storyId: operation.request.storyId,
        createdAt: operation.createdAt,
      };
    },
  );
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

function operationMarker(operationId: string): string {
  return `BB operation reference: ${operationId}`;
}

function consultationMarker(consultationId: string): string {
  return `BB consultation reference: ${consultationId}`;
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
      description:
        "Create a token with threads:read:own and threads:write scopes in Korey settings.",
      secret: true,
    },
  });

  if (!(await settings.get()).apiToken) {
    bb.status.needsConfiguration(
      "Add a Korey personal access token in Settings -> Plugins -> Korey.",
    );
  }

  async function client(): Promise<KoreyClient> {
    const { apiToken } = await settings.get();
    if (!apiToken) {
      throw new Error(
        "Korey is not configured. Add a personal access token in plugin settings.",
      );
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
    return `BB: ${label}`.slice(0, 120 - suffix.length) + suffix;
  }

  async function findMappedThread(
    api: KoreyClient,
    marker: string,
    signal?: AbortSignal,
  ): Promise<KoreyThread | null> {
    const token = `${MAPPING_MARKER_PREFIX}:${marker}`;
    const matches: KoreyThread[] = [];
    let after: string | undefined;
    do {
      const page = await api.listThreads({
        after,
        limit: 50,
        query: token,
        signal,
      });
      matches.push(
        ...page.data.filter((thread) => thread.name?.includes(token) ?? false),
      );
      if (!page.has_more) break;
      if (page.last_id === null || page.last_id === after) {
        throw new Error("Korey thread pagination did not advance");
      }
      after = page.last_id;
    } while (matches.length < 2);
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
          "The Korey destination changed after approval; review and approve a new request.",
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
        "The Korey destination changed after approval; review and approve a new request.",
      );
    }
    if (mapping.state !== "reserved" || mapping.marker === null) {
      throw new Error(`Stored Korey mapping for ${bbThreadId} is invalid`);
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
          name: await bbThreadName(bbThreadId, mapping.marker),
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
      const api = await client();
      const thread = await api.getThread(koreyThreadId, signal);
      assertPrivateThread(thread);
      setLinkedMapping(db, bbThreadId, thread.id);
      return thread;
    });
  }

  async function unlinkThread(bbThreadId: string): Promise<boolean> {
    return withThreadLock(bbThreadId, async () =>
      setUnlinkedMapping(db, bbThreadId),
    );
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
      return {
        created: linked.created,
        koreyThread,
        responseText: boundedText(formatKoreyMessages(messages)).text,
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

  async function approvalDestination(
    api: KoreyClient,
    bbThreadId: string,
    signal?: AbortSignal,
  ) {
    const destination = mappingDestination(bbThreadId);
    if (destination.kind === "new-private-thread") return destination;
    const thread = await api.getThread(destination.koreyThreadId, signal);
    assertPrivateThread(thread);
    return { ...destination, koreyThreadRevision: thread.updated_at };
  }

  function mappingStillMatches(request: ShortcutApprovalPayload): boolean {
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

  function approvedMappingMatches(
    request: ShortcutApprovalPayload,
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

  function unresolvedOperationsStillMatch(
    request: ShortcutApprovalPayload,
  ): boolean {
    return (
      JSON.stringify(
        unresolvedOperationSummaries(
          db,
          request.bbThreadId,
          request.destination.koreyThreadId,
        ),
      ) === JSON.stringify(request.unresolvedOperations)
    );
  }

  function shortcutPrompt(request: ShortcutApprovalPayload): string {
    return request.action === "create"
      ? [
          "The user approved this external write through bb's confirmation UI.",
          operationMarker(request.operationId),
          "Create exactly one Shortcut Story in the connected workspace.",
          "Return the created Story ID and URL. Do not create a duplicate if this operation reference already appears in the conversation.",
          "",
          request.instruction,
        ].join("\n")
      : [
          "The user approved this external write through bb's confirmation UI.",
          operationMarker(request.operationId),
          `Update Shortcut Story ${request.storyId}.`,
          "Preserve unrelated fields. Return the Story ID, URL, and fields changed.",
          "",
          request.instruction,
        ].join("\n");
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
      shortcutPrompt(operation.request),
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

  async function executeApprovedOperation(
    api: KoreyClient,
    operation: OperationRecord,
    prepared: readonly PreparedAttachment[],
    signal?: AbortSignal,
  ): Promise<OperationRecord> {
    transitionOperation(db, {
      id: operation.id,
      from: "approved",
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
        operation.request.destination.kind === "new-private-thread"
          ? {
              previousGeneration:
                operation.request.destination.mappingGeneration,
              marker: operation.id,
            }
          : undefined,
      );
      if (!approvedMappingMatches(operation.request, linked.mapping)) {
        throw new Error(
          "The Korey destination changed after approval; review and approve a new request.",
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
        operation.request.destination.kind === "linked-private-thread" &&
        koreyThread.updated_at !==
          operation.request.destination.koreyThreadRevision
      ) {
        throw new Error(
          "The Korey conversation changed after approval; review and approve a new request.",
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
        `Korey operation ${operation.id} stopped before sending a Shortcut message. Request a new approval only after resolving the error. ${error instanceof Error ? error.message : String(error)}`,
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
          `Korey operation ${operation.id} sent no Shortcut message because attachment upload did not complete. Uploaded files may still consume the thread quota; inspect Korey before starting a new approved operation.`,
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

    // Recovery in a previous BB thread can change this conversation's journal
    // while preparation awaits Korey, outside the current BB-thread lock.
    if (!unresolvedOperationsStillMatch(operation.request)) {
      transitionOperation(db, {
        id: operation.id,
        from: "attachments-uploaded",
        to: "definite-failure",
        patch: {
          error:
            "No Shortcut message was dispatched because unresolved operation state changed during preparation",
        },
      });
      throw new Error(
        `Korey operation ${operation.id} sent no Shortcut message because unresolved operation state changed. Review and approve a new request.`,
      );
    }
    transitionOperation(db, {
      id: operation.id,
      from: "attachments-uploaded",
      to: "message-dispatching",
    });
    try {
      const sent = await api.sendMessage(
        koreyThread.id,
        shortcutPrompt(operation.request),
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
    const api = await client();
    const [prepared, identity, destination] = await Promise.all([
      readAttachments(bbThreadId, input.files ?? [], signal),
      api.identity(signal),
      approvalDestination(api, bbThreadId, signal),
    ]);
    const operationId = `korey-${randomUUID()}`;
    const unsigned = {
      operationId,
      bbThreadId,
      action: input.action,
      storyId,
      instruction: input.instruction.trim(),
      koreyOrganization: identity.korey_organization_slug,
      destination,
      attachments: prepared.map(({ summary }) => summary),
      unresolvedOperations: unresolvedOperationSummaries(
        db,
        bbThreadId,
        destination.koreyThreadId,
      ),
    };
    const request = shortcutApprovalPayloadSchema.parse({
      ...unsigned,
      payloadHash: hash(JSON.stringify(unsigned)),
    });
    let operation = createOperation(db, request);

    let interaction;
    try {
      interaction = await bb.ui.requestInput(
        {
          threadId: bbThreadId,
          rendererId: SHORTCUT_APPROVAL_RENDERER_ID,
          title: `${input.action === "create" ? "Create" : "Update"} Shortcut Story`,
          payload: request,
        },
        { signal },
      );
    } catch (error) {
      transitionOperation(db, {
        id: operation.id,
        from: "awaiting-approval",
        to: "cancelled",
        patch: {
          error: `Approval could not be shown: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
      throw error;
    }
    if (interaction.outcome === "cancelled") {
      transitionOperation(db, {
        id: operation.id,
        from: "awaiting-approval",
        to: "cancelled",
        patch: { error: `Approval cancelled (${interaction.reason})` },
      });
      throw new Error(
        `Shortcut change was not sent because approval was cancelled (${interaction.reason}).`,
      );
    }
    const approval = shortcutApprovalResponseSchema.safeParse(
      interaction.value,
    );
    if (
      !approval.success ||
      approval.data.operationId !== request.operationId ||
      approval.data.payloadHash !== request.payloadHash
    ) {
      transitionOperation(db, {
        id: operation.id,
        from: "awaiting-approval",
        to: "cancelled",
        patch: { error: "Approval did not match the immutable request" },
      });
      throw new Error(
        "Shortcut change was not sent because the approval did not match the request.",
      );
    }

    return withThreadLock(bbThreadId, async () => {
      if (!unresolvedOperationsStillMatch(request)) {
        transitionOperation(db, {
          id: operation.id,
          from: "awaiting-approval",
          to: "cancelled",
          patch: {
            error:
              "The set of unresolved Shortcut operations changed while approval was pending",
          },
        });
        throw new Error(
          "Shortcut change was not sent because unresolved operation state changed. Review and approve a new request.",
        );
      }
      if (!mappingStillMatches(request)) {
        transitionOperation(db, {
          id: operation.id,
          from: "awaiting-approval",
          to: "cancelled",
          patch: {
            error:
              "The linked Korey destination changed while approval was pending",
          },
        });
        throw new Error(
          "Shortcut change was not sent because the Korey destination changed. Review and approve a new request.",
        );
      }
      operation = transitionOperation(db, {
        id: operation.id,
        from: "awaiting-approval",
        to: "approved",
        patch: { approvedAt: Date.now(), error: null },
      });
      return executeApprovedOperation(api, operation, prepared, signal);
    });
  }

  function operationForThread(
    bbThreadId: string,
    operationId: string,
  ): OperationRecord {
    const operation = getOperation(db, operationId);
    if (operation === null || operation.bbThreadId !== bbThreadId) {
      throw new Error(`Unknown Korey operation ${operationId}`);
    }
    return operation;
  }

  async function resumeOperation(
    bbThreadId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<OperationRecord> {
    return withThreadLock(bbThreadId, async () => {
      const operation = operationForThread(bbThreadId, operationId);
      if (operation.status === "korey-complete") return operation;
      return finishOperationPolling(await client(), operation, signal);
    });
  }

  async function reconcileOperation(
    bbThreadId: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<{ reconciled: boolean; operation: OperationRecord }> {
    return withThreadLock(bbThreadId, async () => {
      let operation = operationForThread(bbThreadId, operationId);
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

  bb.cli.register({
    name: "korey",
    summary: "Consult Korey and manage linked conversations",
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
          if (action === "list") {
            if (operationId !== undefined || extra.length > 0) {
              throw new Error("operation list accepts no operation ID");
            }
            const operations = listOperations(
              db,
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
              "operation requires list, show <id>, resume <id>, or reconcile <id>",
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
        return {
          exitCode: 1,
          stderr: `${error instanceof Error ? error.message : String(error)}\n`,
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
      "Ask Korey for product analysis or a draft in the conversation linked to this bb thread. The plugin instructs Korey not to write to connected systems, but Korey's API does not technically restrict connector capabilities.",
    instructions:
      "Use korey_ask for consultation and drafting. Do not represent it as a hard capability sandbox. Use korey_shortcut_change for an intended Shortcut write; that tool always displays an immutable approval request to the user.",
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
        };
      });
    },
  });

  bb.agents.registerTool({
    name: "korey_shortcut_change",
    description:
      "Request a Shortcut Story create or update through Korey. Before any write-intended message is sent, bb shows the user an approval bound to the exact action, destination, instruction, and attachment hashes.",
    instructions:
      "Call only when the user requested the exact Shortcut create or update. The plugin obtains its own interactive approval; do not claim approval in tool arguments. Never retry a failed or unresolved operation by calling this tool again. Inspect it with korey_get_operation, then use korey_resume_operation or korey_reconcile_operation when applicable.",
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
      "List recent Korey Shortcut operations for the current bb thread.",
    parameters: z
      .object({ limit: z.number().int().min(1).max(50).default(20) })
      .strict(),
    async execute({ limit }, context) {
      return JSON.stringify(
        listOperations(db, context.threadId, limit).map(operationView),
        null,
        2,
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
      "Korey is connected through a provider-independent bb plugin. Consultation is prompt-mediated, while intended Shortcut writes require a bb-owned approval. Never replace or automatically retry an ambiguous operation; inspect, resume, or reconcile its existing operation ID.",
  }));
}
