import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ShortcutApprovalPayload } from "./contracts.js";

type Db = ReturnType<BbPluginApi["storage"]["database"]>;

export const operationStatusSchema = z.enum([
  "awaiting-approval",
  "cancelled",
  "approved",
  "preparing",
  "thread-ready",
  "attachment-upload-dispatching",
  "attachments-uploaded",
  "message-dispatching",
  "awaiting-response",
  "korey-complete",
  "definite-failure",
  "reconcile-required",
]);
export type OperationStatus = z.infer<typeof operationStatusSchema>;

const mappingStateSchema = z.enum([
  "unlinked",
  "reserved",
  "create-dispatching",
  "ready",
  "reconcile-required",
]);
export type MappingState = z.infer<typeof mappingStateSchema>;

const mappingRowSchema = z
  .object({
    bb_thread_id: z.string(),
    korey_thread_id: z.string().nullable(),
    marker: z.string().nullable(),
    state: mappingStateSchema,
    generation: z.number().int().nonnegative(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
  })
  .strict();

const operationRowSchema = z
  .object({
    id: z.string(),
    bb_thread_id: z.string(),
    status: operationStatusSchema,
    request_json: z.string(),
    request_hash: z.string(),
    request_version: z.number().int().positive(),
    dispatched_text: z.string().nullable(),
    korey_thread_id: z.string().nullable(),
    korey_message_id: z.string().nullable(),
    attachment_ids_json: z.string().nullable(),
    response_text: z.string().nullable(),
    response_truncated: z.number().int(),
    error: z.string().nullable(),
    created_at: z.number().int(),
    updated_at: z.number().int(),
    approved_at: z.number().int().nullable(),
    completed_at: z.number().int().nullable(),
  })
  .strict();

export interface MappingRecord {
  bbThreadId: string;
  koreyThreadId: string | null;
  marker: string | null;
  state: MappingState;
  generation: number;
  createdAt: number;
  updatedAt: number;
}

export interface OperationRecord {
  id: string;
  bbThreadId: string;
  status: OperationStatus;
  request: Record<string, unknown>;
  requestHash: string;
  requestVersion: number;
  dispatchedText: string | null;
  koreyThreadId: string | null;
  koreyMessageId: string | null;
  attachmentIds: string[];
  responseText: string | null;
  responseTruncated: boolean;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  completedAt: number | null;
}

export const migrations = [
  `CREATE TABLE korey_mappings (
     bb_thread_id TEXT PRIMARY KEY,
     korey_thread_id TEXT UNIQUE,
     marker TEXT UNIQUE,
     state TEXT NOT NULL,
     generation INTEGER NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE korey_operations (
     id TEXT PRIMARY KEY,
     bb_thread_id TEXT NOT NULL,
     status TEXT NOT NULL,
     request_json TEXT NOT NULL,
     request_hash TEXT NOT NULL,
     korey_thread_id TEXT,
     korey_message_id TEXT,
     attachment_ids_json TEXT,
     response_text TEXT,
     response_truncated INTEGER NOT NULL DEFAULT 0,
     error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     approved_at INTEGER,
     completed_at INTEGER
   );
   CREATE INDEX korey_operations_thread_created_idx
     ON korey_operations(bb_thread_id, created_at DESC);`,
  `CREATE INDEX korey_operations_destination_idx
     ON korey_operations(korey_thread_id);`,
  `ALTER TABLE korey_operations ADD COLUMN request_version INTEGER NOT NULL DEFAULT 1;
   ALTER TABLE korey_operations ADD COLUMN dispatched_text TEXT;`,
];

function mappingRecord(value: unknown): MappingRecord {
  const row = mappingRowSchema.parse(value);
  return {
    bbThreadId: row.bb_thread_id,
    koreyThreadId: row.korey_thread_id,
    marker: row.marker,
    state: row.state,
    generation: row.generation,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function operationRecord(value: unknown): OperationRecord {
  const row = operationRowSchema.parse(value);
  const attachmentIds =
    row.attachment_ids_json === null
      ? []
      : z.array(z.string().min(1)).parse(JSON.parse(row.attachment_ids_json));
  return {
    id: row.id,
    bbThreadId: row.bb_thread_id,
    status: row.status,
    // Historical approvals are data, not executable requests. Only the write
    // path validates against the current approval contract.
    request: z
      .record(z.string(), z.unknown())
      .parse(JSON.parse(row.request_json)),
    requestHash: row.request_hash,
    requestVersion: row.request_version,
    dispatchedText: row.dispatched_text,
    koreyThreadId: row.korey_thread_id,
    koreyMessageId: row.korey_message_id,
    attachmentIds,
    responseText: row.response_text,
    responseTruncated: row.response_truncated === 1,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    approvedAt: row.approved_at,
    completedAt: row.completed_at,
  };
}

export function getMapping(db: Db, bbThreadId: string): MappingRecord | null {
  const row = db
    .prepare("SELECT * FROM korey_mappings WHERE bb_thread_id = ?")
    .get(bbThreadId);
  return row === undefined ? null : mappingRecord(row);
}

export function reserveMapping(
  db: Db,
  bbThreadId: string,
  marker: string,
): MappingRecord {
  return db
    .transaction(() => {
      const existing = getMapping(db, bbThreadId);
      if (existing !== null && existing.state !== "unlinked") return existing;
      const now = Date.now();
      if (existing === null) {
        db.prepare(
          `INSERT INTO korey_mappings (
             bb_thread_id, korey_thread_id, marker, state, generation,
             created_at, updated_at
           ) VALUES (?, NULL, ?, 'reserved', 1, ?, ?)`,
        ).run(bbThreadId, marker, now, now);
      } else {
        db.prepare(
          `UPDATE korey_mappings
             SET korey_thread_id = NULL, marker = ?, state = 'reserved',
                 generation = generation + 1, updated_at = ?
           WHERE bb_thread_id = ? AND state = 'unlinked'`,
        ).run(marker, now, bbThreadId);
      }
      return getMappingRequired(db, bbThreadId);
    })
    .immediate();
}

export function beginMappingCreate(
  db: Db,
  bbThreadId: string,
  generation: number,
): boolean {
  return (
    db
      .prepare(
        `UPDATE korey_mappings
            SET state = 'create-dispatching', updated_at = ?
          WHERE bb_thread_id = ? AND generation = ? AND state = 'reserved'`,
      )
      .run(Date.now(), bbThreadId, generation).changes === 1
  );
}

export function completeMappingCreate(
  db: Db,
  args: { bbThreadId: string; generation: number; koreyThreadId: string },
): void {
  const changed = db
    .prepare(
      `UPDATE korey_mappings
          SET korey_thread_id = ?, state = 'ready', updated_at = ?
        WHERE bb_thread_id = ? AND generation = ?
          AND state IN ('create-dispatching', 'reconcile-required')`,
    )
    .run(
      args.koreyThreadId,
      Date.now(),
      args.bbThreadId,
      args.generation,
    ).changes;
  if (changed !== 1) throw new Error("Korey mapping changed during creation");
}

export function rejectMappingCreate(
  db: Db,
  bbThreadId: string,
  generation: number,
): void {
  const changed = db
    .prepare(
      `UPDATE korey_mappings
          SET korey_thread_id = NULL, marker = NULL, state = 'unlinked',
              updated_at = ?
        WHERE bb_thread_id = ? AND generation = ?
          AND state = 'create-dispatching'`,
    )
    .run(Date.now(), bbThreadId, generation).changes;
  if (changed !== 1) {
    throw new Error("Korey mapping changed while creation was rejected");
  }
}

export function requireMappingReconciliation(
  db: Db,
  bbThreadId: string,
  generation: number,
): void {
  db.prepare(
    `UPDATE korey_mappings
        SET state = 'reconcile-required', updated_at = ?
      WHERE bb_thread_id = ? AND generation = ?
        AND state = 'create-dispatching'`,
  ).run(Date.now(), bbThreadId, generation);
}

export function setLinkedMapping(
  db: Db,
  bbThreadId: string,
  koreyThreadId: string,
): MappingRecord {
  const now = Date.now();
  db.prepare(
    `INSERT INTO korey_mappings (
       bb_thread_id, korey_thread_id, marker, state, generation,
       created_at, updated_at
     ) VALUES (?, ?, NULL, 'ready', 1, ?, ?)
     ON CONFLICT(bb_thread_id) DO UPDATE SET
       korey_thread_id = excluded.korey_thread_id,
       marker = NULL,
       state = 'ready',
       generation = korey_mappings.generation + 1,
       updated_at = excluded.updated_at`,
  ).run(bbThreadId, koreyThreadId, now, now);
  return getMappingRequired(db, bbThreadId);
}

export function setUnlinkedMapping(db: Db, bbThreadId: string): boolean {
  return db
    .transaction(() => {
      const existing = getMapping(db, bbThreadId);
      if (existing === null) {
        const now = Date.now();
        db.prepare(
          `INSERT INTO korey_mappings (
             bb_thread_id, korey_thread_id, marker, state, generation,
             created_at, updated_at
           ) VALUES (?, NULL, NULL, 'unlinked', 1, ?, ?)`,
        ).run(bbThreadId, now, now);
        return false;
      }
      const linked = existing.state !== "unlinked";
      db.prepare(
        `UPDATE korey_mappings
            SET korey_thread_id = NULL, marker = NULL, state = 'unlinked',
                generation = generation + 1, updated_at = ?
          WHERE bb_thread_id = ?`,
      ).run(Date.now(), bbThreadId);
      return linked;
    })
    .immediate();
}

function getMappingRequired(db: Db, bbThreadId: string): MappingRecord {
  const mapping = getMapping(db, bbThreadId);
  if (mapping === null)
    throw new Error(`Missing Korey mapping for ${bbThreadId}`);
  return mapping;
}

export function createOperation(
  db: Db,
  request: ShortcutApprovalPayload,
): OperationRecord {
  const now = Date.now();
  db.prepare(
    `INSERT INTO korey_operations (
       id, bb_thread_id, status, request_json, request_hash, created_at, updated_at
     ) VALUES (?, ?, 'awaiting-approval', ?, ?, ?, ?)`,
  ).run(
    request.operationId,
    request.bbThreadId,
    JSON.stringify(request),
    request.payloadHash,
    now,
    now,
  );
  return getOperationRequired(db, request.operationId);
}

export function getOperation(db: Db, id: string): OperationRecord | null {
  const row = db.prepare("SELECT * FROM korey_operations WHERE id = ?").get(id);
  return row === undefined ? null : operationRecord(row);
}

export function listOperations(
  db: Db,
  bbThreadId: string,
  limit: number,
): OperationRecord[] {
  return db
    .prepare(
      `SELECT * FROM korey_operations
        WHERE bb_thread_id = ?
        ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(bbThreadId, limit)
    .map(operationRecord);
}

export function listUnresolvedOperations(
  db: Db,
  bbThreadId: string,
  koreyThreadId: string | null,
): OperationRecord[] {
  return db
    .prepare(
      `SELECT * FROM korey_operations
        WHERE (bb_thread_id = ? OR korey_thread_id = ?)
          AND status IN ('awaiting-response', 'reconcile-required')
        ORDER BY created_at ASC, id ASC`,
    )
    .all(bbThreadId, koreyThreadId)
    .map(operationRecord);
}

interface OperationPatch {
  dispatchedText?: string;
  koreyThreadId?: string;
  koreyMessageId?: string;
  attachmentIds?: readonly string[];
  responseText?: string;
  responseTruncated?: boolean;
  error?: string | null;
  approvedAt?: number;
  completedAt?: number;
}

export function transitionOperation(
  db: Db,
  args: {
    id: string;
    from: OperationStatus | readonly OperationStatus[];
    to: OperationStatus;
    patch?: OperationPatch;
  },
): OperationRecord {
  const from = Array.isArray(args.from) ? args.from : [args.from];
  const sets = ["status = @status", "updated_at = @updatedAt"];
  const values: Record<string, string | number | null> = {
    id: args.id,
    status: args.to,
    updatedAt: Date.now(),
  };
  const patch = args.patch ?? {};
  if (patch.dispatchedText !== undefined) {
    sets.push("dispatched_text = @dispatchedText");
    values.dispatchedText = patch.dispatchedText;
  }
  if (patch.koreyThreadId !== undefined) {
    sets.push("korey_thread_id = @koreyThreadId");
    values.koreyThreadId = patch.koreyThreadId;
  }
  if (patch.koreyMessageId !== undefined) {
    sets.push("korey_message_id = @koreyMessageId");
    values.koreyMessageId = patch.koreyMessageId;
  }
  if (patch.attachmentIds !== undefined) {
    sets.push("attachment_ids_json = @attachmentIdsJson");
    values.attachmentIdsJson = JSON.stringify(patch.attachmentIds);
  }
  if (patch.responseText !== undefined) {
    sets.push("response_text = @responseText");
    values.responseText = patch.responseText;
  }
  if (patch.responseTruncated !== undefined) {
    sets.push("response_truncated = @responseTruncated");
    values.responseTruncated = patch.responseTruncated ? 1 : 0;
  }
  if (patch.error !== undefined) {
    sets.push("error = @error");
    values.error = patch.error;
  }
  if (patch.approvedAt !== undefined) {
    sets.push("approved_at = @approvedAt");
    values.approvedAt = patch.approvedAt;
  }
  if (patch.completedAt !== undefined) {
    sets.push("completed_at = @completedAt");
    values.completedAt = patch.completedAt;
  }
  const placeholders = from.map((_, index) => `@from${index}`);
  from.forEach((status, index) => {
    values[`from${index}`] = status;
  });
  const changed = db
    .prepare(
      `UPDATE korey_operations SET ${sets.join(", ")}
        WHERE id = @id AND status IN (${placeholders.join(", ")})`,
    )
    .run(values).changes;
  if (changed !== 1) {
    const current = getOperation(db, args.id);
    throw new Error(
      current === null
        ? `Unknown Korey operation ${args.id}`
        : `Korey operation ${args.id} is ${current.status}, not ${from.join(" or ")}`,
    );
  }
  return getOperationRequired(db, args.id);
}

export function updateOperationError(
  db: Db,
  id: string,
  error: string,
): OperationRecord {
  const changed = db
    .prepare(
      `UPDATE korey_operations SET error = ?, updated_at = ? WHERE id = ?`,
    )
    .run(error, Date.now(), id).changes;
  if (changed !== 1) throw new Error(`Unknown Korey operation ${id}`);
  return getOperationRequired(db, id);
}

export function recoverInterruptedOperations(db: Db): void {
  const now = Date.now();
  db.prepare(
    `UPDATE korey_operations
        SET status = 'cancelled', error = 'Approval ended when the plugin stopped',
            updated_at = ?
      WHERE status = 'awaiting-approval'`,
  ).run(now);
  db.prepare(
    `UPDATE korey_operations
        SET status = 'definite-failure',
            error = 'The plugin stopped before a Shortcut message was dispatched; request a new approval to try again',
            updated_at = ?
      WHERE status IN (
        'approved', 'preparing', 'thread-ready',
        'attachment-upload-dispatching', 'attachments-uploaded'
      )`,
  ).run(now);
  db.prepare(
    `UPDATE korey_operations
        SET status = 'reconcile-required',
            error = COALESCE(error, 'The plugin stopped while dispatching the Korey message'),
            updated_at = ?
      WHERE status = 'message-dispatching'`,
  ).run(now);
}

function getOperationRequired(db: Db, id: string): OperationRecord {
  const operation = getOperation(db, id);
  if (operation === null) throw new Error(`Unknown Korey operation ${id}`);
  return operation;
}
