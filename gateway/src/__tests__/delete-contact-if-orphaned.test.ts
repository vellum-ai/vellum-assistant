/**
 * Unit tests for the orphaned-seed contact GC (`deleteContactIfOrphaned`).
 *
 * Deletion must be provably narrow: only a principal-less `contact`-role row
 * with no channels and no guardian-authored configuration qualifies, and the
 * final delete must re-verify that atomically. The mirror probe awaits IPC,
 * so a concurrent write (an inbound seed attaching a channel) can land in
 * the gap; the guarded DELETE is what keeps that from cascade-deleting the
 * fresh channel.
 *
 * The gateway DB is real, so assertions count rows. The mirror probe is a
 * controllable stub: tests park it on a deferred promise to open the race
 * window deliberately.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "./test-preload.js";

// A real socket file so the mirror counts as reachable and the probe runs.
const socketDir = mkdtempSync(join(tmpdir(), "orphan-gc-"));
const socketPath = join(socketDir, "assistant.sock");
writeFileSync(socketPath, "");
mock.module("../ipc/endpoint.js", () => ({
  resolveIpcSocketPath: () => ({ path: socketPath, source: "test" }),
}));

type MirrorProbe = {
  exists: boolean;
  hasChannels: boolean;
  notes: string | null;
  userFile: string | null;
  contactType: string | null;
  hasMetadata: boolean;
};
const ABSENT_MIRROR: MirrorProbe = {
  exists: false,
  hasChannels: false,
  notes: null,
  userFile: null,
  contactType: null,
  hasMetadata: false,
};
let probeImpl: () => Promise<MirrorProbe> = async () => ABSENT_MIRROR;

const actualContactsInfoClient = await import("../ipc/contacts-info-client.js");
mock.module("../ipc/contacts-info-client.js", () => ({
  ...actualContactsInfoClient,
  probeContactMirror: () => probeImpl(),
}));

const mirrorCalls: { method: string; body: unknown }[] = [];
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: async (method: string, opts?: { body?: unknown }) => {
    mirrorCalls.push({ method, body: opts?.body });
    return {};
  },
}));

// Import after mocks so the helper binds the stubbed probe.
const { deleteContactIfOrphaned } =
  await import("../verification/contact-helpers.js");
const { initGatewayDb, getGatewayDb, resetGatewayDb } =
  await import("../db/connection.js");
const { contacts, contactChannels, ingressInvites } =
  await import("../db/schema.js");
const { seedInvite } = await import("./helpers/contact-fixtures.js");

function seedContact(opts: {
  id: string;
  role?: string;
  principalId?: string | null;
  autoApproveThreshold?: string | null;
}): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id: opts.id,
      displayName: `name-${opts.id}`,
      role: opts.role ?? "contact",
      principalId: opts.principalId ?? null,
      autoApproveThreshold: opts.autoApproveThreshold ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedChannel(contactId: string, id: string): void {
  const now = Date.now();
  getGatewayDb()
    .insert(contactChannels)
    .values({
      id,
      contactId,
      type: "slack",
      address: `U-${id}`,
      isPrimary: false,
      status: "unverified",
      policy: "allow",
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function contactIds(): string[] {
  return getGatewayDb()
    .select({ id: contacts.id })
    .from(contacts)
    .all()
    .map((r) => r.id);
}

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(ingressInvites).run();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
  probeImpl = async () => ABSENT_MIRROR;
  mirrorCalls.length = 0;
});

afterAll(() => {
  resetGatewayDb();
});

describe("eligibility", () => {
  test("a qualifying orphan is deleted (both stores when the mirror row exists)", async () => {
    seedContact({ id: "orphan" });
    // A present mirror stub row: default classification, nothing authored.
    probeImpl = async () => ({
      ...ABSENT_MIRROR,
      exists: true,
      contactType: "human",
    });

    await deleteContactIfOrphaned("orphan");

    expect(contactIds()).toEqual([]);
    expect(
      mirrorCalls.filter((c) => c.method === "contacts_mirror_delete_contact"),
    ).toHaveLength(1);
  });

  test("a guardian-set auto-approve ceiling vetoes the delete", async () => {
    // A threshold is guardian-authored configuration: the contact is real,
    // not a disposable seed, even with zero channels.
    seedContact({ id: "configured", autoApproveThreshold: "low" });

    await deleteContactIfOrphaned("configured");

    expect(contactIds()).toEqual(["configured"]);
  });

  test("a principal-bearing or non-contact-role row is never deleted", async () => {
    seedContact({ id: "bound", principalId: "principal-1" });
    seedContact({ id: "guardian", role: "guardian" });

    await deleteContactIfOrphaned("bound");
    await deleteContactIfOrphaned("guardian");

    expect(contactIds().sort()).toEqual(["bound", "guardian"]);
  });

  test("an invite targeting the contact vetoes the delete", async () => {
    // Invites are guardian-minted, so any row targeting the contact proves
    // intent, and ingress_invites.contact_id cascades on contact delete: the
    // GC must never take live invites down with a supposed seed.
    seedContact({ id: "invitee" });
    seedInvite({ contactId: "invitee" });

    await deleteContactIfOrphaned("invitee");

    expect(contactIds()).toEqual(["invitee"]);
  });

  test("a remaining channel vetoes the delete", async () => {
    seedContact({ id: "has-channel" });
    seedChannel("has-channel", "ch-1");

    await deleteContactIfOrphaned("has-channel");

    expect(contactIds()).toEqual(["has-channel"]);
  });
});

describe("guarded delete under concurrency", () => {
  test("a channel attached while the mirror probe is pending keeps the contact", async () => {
    seedContact({ id: "racy" });

    // Park the probe so the pre-checks (which saw zero channels) go stale,
    // then attach a channel in the gap, exactly like a concurrent inbound
    // seed. The guarded DELETE must notice and keep contact + channel.
    let releaseProbe: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    probeImpl = async () => {
      await gate;
      return ABSENT_MIRROR;
    };

    const gc = deleteContactIfOrphaned("racy");
    seedChannel("racy", "ch-mid-flight");
    releaseProbe!();
    await gc;

    expect(contactIds()).toEqual(["racy"]);
    expect(getGatewayDb().select().from(contactChannels).all()).toHaveLength(1);
  });
});
