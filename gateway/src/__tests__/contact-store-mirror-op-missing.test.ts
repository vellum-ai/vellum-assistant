/**
 * Unknown-method escalation on the typed contacts mirror ops.
 *
 * An old daemon rejects `contacts_mirror_merge_contact` /
 * `contacts_mirror_upsert_full` with "Unknown method"; the best-effort catch
 * must NOT swallow that silently — it escalates through the mirror-op-missing
 * reporter (error log + `contacts_mirror_op_missing` watchdog telemetry)
 * while the gateway write still stands (no raw-SQL fallback by design). Any
 * other IPC failure keeps the routine best-effort warn: no escalation, same
 * gateway state.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  mock,
} from "bun:test";

import "./test-preload.js";

// ── Mocked daemon IPC (leak-safe: delegates to a mutable mock, spreads the
// actual module so other exports stay importable across suites) ─────────────

type IpcCallFn = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;

const ipcCalls: string[] = [];
// Method name → error to throw whenever it is called.
const ipcThrowOn = new Map<string, Error>();

let ipcCallAssistantMock: ReturnType<typeof mock<IpcCallFn>> = mock(
  async () => ({}),
);

const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: (...args: Parameters<IpcCallFn>) =>
    ipcCallAssistantMock(...args),
}));

// ── Imports ──────────────────────────────────────────────────────────────────

import { ContactStore } from "../db/contact-store.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, contactChannels } from "../db/schema.js";
import {
  MIRROR_OP_MISSING_CHECK_NAME,
  flushMirrorOpReporterForTesting,
  resetMirrorOpReporterForTesting,
  setMirrorOpReporterOverridesForTesting,
} from "../contacts-mirror-op-reporter.js";

// ── Setup ────────────────────────────────────────────────────────────────────

const errorLogs: [Record<string, unknown>, string][] = [];
const warnLogs: unknown[] = [];
let telemetryBodies: unknown[] = [];

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(contactChannels).run();
  db.delete(contacts).run();

  ipcCalls.length = 0;
  ipcThrowOn.clear();
  ipcCallAssistantMock = mock(async (method: string) => {
    ipcCalls.push(method);
    const err = ipcThrowOn.get(method);
    if (err) throw err;
    if (method === "contacts_info_batch") return { infos: [] };
    if (method === "contact_user_file_slugs") return { userFiles: [] };
    return {};
  });

  errorLogs.length = 0;
  warnLogs.length = 0;
  telemetryBodies = [];
  resetMirrorOpReporterForTesting();
  setMirrorOpReporterOverridesForTesting({
    fetchImpl: async (_url, init) => {
      telemetryBodies.push(JSON.parse(String(init?.body)));
      return new Response("{}");
    },
    mintToken: () => "svc-token",
    baseUrl: "http://127.0.0.1:7821",
    log: {
      error: (detail, msg) => {
        errorLogs.push([detail, msg]);
      },
      warn: (detail, msg) => {
        warnLogs.push([detail, msg]);
      },
    },
  });
});

afterEach(() => {
  resetMirrorOpReporterForTesting();
});

afterAll(() => {
  resetGatewayDb();
});

function seedContact(id: string) {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id,
      displayName: `name-${id}`,
      role: "contact",
      principalId: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedChannel(id: string, contactId: string) {
  const now = Date.now();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id,
      contactId,
      type: "slack" as never,
      address: `addr-${id}`,
      isPrimary: false,
      status: "active",
      policy: "allow",
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function unknownMethodError(method: string): Error {
  // Exact shape the daemon IPC server sends for an unregistered method,
  // surfaced by ipcCallAssistant as a transport-level Error message.
  return new Error(`Unknown method: ${method}`);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("mergeContacts — unknown mirror op escalation", () => {
  test("unknown method → error log + telemetry; gateway merge still applied", async () => {
    seedContact("ct_keep");
    seedContact("ct_merge");
    seedChannel("ch_1", "ct_merge");
    ipcThrowOn.set(
      "contacts_mirror_merge_contact",
      unknownMethodError("contacts_mirror_merge_contact"),
    );

    const store = new ContactStore();
    const result = await store.mergeContacts("ct_keep", "ct_merge");
    await flushMirrorOpReporterForTesting();

    // Gateway (source of truth) merge stands: donor gone, channel moved.
    expect(result!.id).toBe("ct_keep");
    const db = getGatewayDb();
    expect(
      db
        .select()
        .from(contacts)
        .all()
        .find((c) => c.id === "ct_merge"),
    ).toBeUndefined();
    expect(
      db
        .select()
        .from(contactChannels)
        .all()
        .find((c) => c.id === "ch_1")?.contactId,
    ).toBe("ct_keep");

    // Escalated: one error log + one watchdog telemetry event.
    expect(errorLogs.length).toBe(1);
    expect(errorLogs[0][0]).toMatchObject({
      op: "contacts_mirror_merge_contact",
      keepId: "ct_keep",
      mergeId: "ct_merge",
    });
    expect(telemetryBodies).toEqual([
      {
        check_name: MIRROR_OP_MISSING_CHECK_NAME,
        detail: {
          op: "contacts_mirror_merge_contact",
          keepId: "ct_keep",
          mergeId: "ct_merge",
        },
      },
    ]);
  });

  test("other IPC failure → best-effort warn only, same gateway state", async () => {
    seedContact("ct_keep");
    seedContact("ct_merge");
    seedChannel("ch_1", "ct_merge");
    ipcThrowOn.set(
      "contacts_mirror_merge_contact",
      new Error("daemon unavailable"),
    );

    const store = new ContactStore();
    const result = await store.mergeContacts("ct_keep", "ct_merge");
    await flushMirrorOpReporterForTesting();

    expect(result!.id).toBe("ct_keep");
    expect(
      getGatewayDb()
        .select()
        .from(contacts)
        .all()
        .find((c) => c.id === "ct_merge"),
    ).toBeUndefined();

    // No escalation: no reporter error log, no telemetry.
    expect(errorLogs.length).toBe(0);
    expect(telemetryBodies).toEqual([]);
  });
});

describe("upsertContact — unknown mirror op escalation", () => {
  test("unknown method → error log + telemetry; gateway upsert still applied", async () => {
    ipcThrowOn.set(
      "contacts_mirror_upsert_full",
      unknownMethodError("contacts_mirror_upsert_full"),
    );

    const store = new ContactStore();
    const { contact, created } = await store.upsertContact({
      displayName: "Alice",
      channels: [{ type: "slack", address: "U12345" }],
    });
    await flushMirrorOpReporterForTesting();

    // Gateway write stands.
    expect(created).toBe(true);
    expect(
      getGatewayDb()
        .select()
        .from(contacts)
        .all()
        .find((c) => c.id === contact.id),
    ).toBeDefined();
    expect(store.getChannelsForContact(contact.id)).toHaveLength(1);

    expect(errorLogs.length).toBe(1);
    expect(errorLogs[0][0]).toMatchObject({
      op: "contacts_mirror_upsert_full",
      contactId: contact.id,
    });
    expect(telemetryBodies).toEqual([
      {
        check_name: MIRROR_OP_MISSING_CHECK_NAME,
        detail: { op: "contacts_mirror_upsert_full", contactId: contact.id },
      },
    ]);
  });

  test("other IPC failure → best-effort warn only, same gateway state", async () => {
    ipcThrowOn.set("contacts_mirror_upsert_full", new Error("socket closed"));

    const store = new ContactStore();
    const { contact, created } = await store.upsertContact({
      displayName: "Bob",
      channels: [{ type: "slack", address: "U67890" }],
    });
    await flushMirrorOpReporterForTesting();

    expect(created).toBe(true);
    expect(store.getChannelsForContact(contact.id)).toHaveLength(1);
    expect(errorLogs.length).toBe(0);
    expect(telemetryBodies).toEqual([]);
  });
});
