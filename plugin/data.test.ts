import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { shortcutApprovalPayloadSchema } from "./contracts.js";
import {
  beginMappingCreate,
  createOperation,
  getOperation,
  getMapping,
  listUnresolvedOperations,
  migrations,
  recoverInterruptedOperations,
  reserveMapping,
  setLinkedMapping,
  transitionOperation,
} from "./data.js";

function request(operationId: string) {
  return shortcutApprovalPayloadSchema.parse({
    operationId,
    payloadHash: "a".repeat(64),
    bbThreadId: "thread-test",
    action: "create",
    storyId: null,
    instruction: "Create the approved Story.",
    koreyOrganization: "example",
    destination: {
      kind: "new-private-thread",
      koreyThreadId: null,
      koreyThreadRevision: null,
      mappingGeneration: 0,
    },
    attachments: [],
    unresolvedOperations: [],
  });
}

describe("Korey durable state", () => {
  it("keeps one-to-one links and explains how to move an existing link", () => {
    const db = new Database(":memory:");
    try {
      migrations.forEach((migration) => db.exec(migration));
      const original = setLinkedMapping(db, "thread-one", "korey-one");
      expect(() => setLinkedMapping(db, "thread-two", "korey-one")).toThrow(
        "bb korey unlink --bb-thread thread-one",
      );
      expect(getMapping(db, "thread-one")).toEqual(original);
      expect(getMapping(db, "thread-two")).toBeNull();
      expect(setLinkedMapping(db, "thread-one", "korey-one").state).toBe(
        "ready",
      );
    } finally {
      db.close();
    }
  });

  it("releases undispatched reservations on restart and preserves ambiguous creation markers", () => {
    const db = new Database(":memory:");
    try {
      migrations.forEach((migration) => db.exec(migration));
      reserveMapping(db, "reserved", "marker-one");
      const creating = reserveMapping(db, "creating", "marker-two");
      beginMappingCreate(db, "creating", creating.generation);
      const linked = setLinkedMapping(db, "ready", "korey-one");
      recoverInterruptedOperations(db);
      expect(getMapping(db, "reserved")).toMatchObject({
        state: "unlinked",
        marker: null,
        generation: 2,
      });
      expect(getMapping(db, "creating")).toMatchObject({
        state: "reconcile-required",
        marker: "marker-two",
        generation: creating.generation,
      });
      expect(getMapping(db, "ready")).toEqual(linked);
      recoverInterruptedOperations(db);
      expect(getMapping(db, "reserved")?.generation).toBe(2);
    } finally {
      db.close();
    }
  });

  it("migrates old journals and reads historical requests without today's approval schema", () => {
    const db = new Database(":memory:");
    try {
      migrations.slice(0, 2).forEach((migration) => db.exec(migration));
      const snapshot = { ...request("korey-1"), futureField: true };
      db.prepare(`INSERT INTO korey_operations
        (id, bb_thread_id, status, request_json, request_hash, created_at, updated_at)
        VALUES (?, ?, 'reconcile-required', ?, ?, 1, 1)`).run(
        "korey-1",
        "thread-test",
        JSON.stringify(snapshot),
        snapshot.payloadHash,
      );
      migrations.slice(2).forEach((migration) => db.exec(migration));
      expect(getOperation(db, "korey-1")).toMatchObject({
        request: snapshot,
        requestVersion: 1,
        dispatchedText: null,
      });
      db.prepare(
        "UPDATE korey_operations SET request_json = ?, request_version = 2",
      ).run(JSON.stringify({ action: "future-action" }));
      expect(listUnresolvedOperations(db, "thread-test", null)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("selects unresolved operations from either origin or destination without duplicates", () => {
    const db = new Database(":memory:");
    try {
      migrations.forEach((migration) => db.exec(migration));
      const seeds = [
        {
          bbThreadId: "thread-b",
          koreyThreadId: "conversation-one",
          status: "reconcile-required",
        },
        {
          bbThreadId: "thread-b",
          koreyThreadId: "conversation-two",
          status: "reconcile-required",
        },
        {
          bbThreadId: "thread-a",
          koreyThreadId: "conversation-one",
          status: "reconcile-required",
        },
        {
          bbThreadId: "thread-a",
          koreyThreadId: "conversation-one",
          status: "awaiting-response",
        },
        {
          bbThreadId: "thread-a",
          koreyThreadId: "conversation-two",
          status: "reconcile-required",
        },
        {
          bbThreadId: "thread-a",
          koreyThreadId: "conversation-one",
          status: "korey-complete",
        },
      ] as const;
      const ids = seeds.map((seed, index) => {
        const id = `korey-${index + 1}`;
        createOperation(db, { ...request(id), bbThreadId: seed.bbThreadId });
        transitionOperation(db, {
          id,
          from: "awaiting-approval",
          to: seed.status,
          patch: { koreyThreadId: seed.koreyThreadId },
        });
        return id;
      });

      expect(
        listUnresolvedOperations(db, "thread-b", "conversation-one").map(
          ({ id }) => id,
        ),
      ).toEqual(ids.slice(0, 4));
      expect(
        listUnresolvedOperations(db, "thread-b", null).map(({ id }) => id),
      ).toEqual(ids.slice(0, 2));
    } finally {
      db.close();
    }
  });

  it("atomically reserves only one first-use mapping", async () => {
    const host = createFakePluginHost({ pluginId: "korey-data-test" });
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, migrations);
    try {
      const first = reserveMapping(db, "thread-test", "marker-one");
      const second = reserveMapping(db, "thread-test", "marker-two");

      expect(first).toMatchObject({
        marker: "marker-one",
        state: "reserved",
        generation: 1,
      });
      expect(second).toEqual(first);
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM korey_mappings").get(),
      ).toEqual({ count: 1 });
    } finally {
      await host.harness.dispose();
    }
  });

  it("recovers interrupted states without replaying remote mutations", async () => {
    const host = createFakePluginHost({ pluginId: "korey-recovery-test" });
    const db = host.bb.storage.database();
    host.bb.storage.migrate(db, migrations);
    try {
      createOperation(
        db,
        request("korey-11111111-1111-4111-8111-111111111111"),
      );
      transitionOperation(db, {
        id: "korey-11111111-1111-4111-8111-111111111111",
        from: "awaiting-approval",
        to: "approved",
      });

      createOperation(
        db,
        request("korey-22222222-2222-4222-8222-222222222222"),
      );
      transitionOperation(db, {
        id: "korey-22222222-2222-4222-8222-222222222222",
        from: "awaiting-approval",
        to: "message-dispatching",
      });

      createOperation(
        db,
        request("korey-33333333-3333-4333-8333-333333333333"),
      );
      transitionOperation(db, {
        id: "korey-33333333-3333-4333-8333-333333333333",
        from: "awaiting-approval",
        to: "awaiting-response",
        patch: {
          koreyMessageId: "message-3",
          koreyThreadId: "thread-3",
        },
      });

      recoverInterruptedOperations(db);

      expect(
        getOperation(db, "korey-11111111-1111-4111-8111-111111111111"),
      ).toMatchObject({ status: "definite-failure" });
      expect(
        getOperation(db, "korey-22222222-2222-4222-8222-222222222222"),
      ).toMatchObject({ status: "reconcile-required" });
      expect(
        getOperation(db, "korey-33333333-3333-4333-8333-333333333333"),
      ).toMatchObject({
        status: "awaiting-response",
        koreyMessageId: "message-3",
      });
    } finally {
      await host.harness.dispose();
    }
  });
});
