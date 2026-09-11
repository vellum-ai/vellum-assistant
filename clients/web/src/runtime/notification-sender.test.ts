import { beforeEach, describe, expect, test } from "bun:test";

import {
  NOTIFICATION_SENDER_NAME_MAX_CHARS,
  type NotificationIdentity,
} from "@vellumai/ipc-contract";

import {
  __clearNotificationIdentitySnapshotsForTests,
  createNotificationIdentity,
  getNotificationIdentitySnapshot,
  publishNotificationIdentitySnapshot,
} from "@/runtime/notification-avatar";
import {
  resolveNotificationSender,
  type ResolveNotificationSenderInput,
} from "@/runtime/notification-sender";

const HASH = "b".repeat(64);
const AVATAR = { avatarBase64: "iVBORw==", avatarHash: HASH };

function identity(
  assistantId: string,
  scopeId = "connection:one",
  nativeSenderId = `native:${scopeId}:${assistantId}`,
): NotificationIdentity {
  const result = createNotificationIdentity(scopeId, assistantId, nativeSenderId);
  if (!result) {
    throw new Error("test identity must be valid");
  }
  return result;
}

function resolve(
  overrides: Partial<ResolveNotificationSenderInput> = {},
) {
  const owner = identity("assistant-a");
  return resolveNotificationSender({
    presentation: "assistant",
    identity: owner,
    assistantName: undefined,
    identityStoreName: undefined,
    verifiedSnapshot: undefined,
    title: "Notification title",
    ...overrides,
  });
}

beforeEach(() => {
  __clearNotificationIdentitySnapshotsForTests();
});

describe("resolveNotificationSender", () => {
  test("uses the trimmed event assistant name before every other source", () => {
    const owner = identity("assistant-a");
    const result = resolve({
      identity: owner,
      assistantName: "  Event Name  ",
      identityStoreName: { identity: owner, name: "Store Name" },
      verifiedSnapshot: {
        identity: owner,
        scopeEpoch: 0,
        identityRevision: 0,
        name: "Memory Name",
        nameProvenance: "event",
        avatar: AVATAR,
      },
      title: "Title Name",
    });

    expect(result).toMatchObject({
      presentation: "assistant",
      name: "Event Name",
      nameProvenance: "event",
      sender: { id: owner.nativeSenderId, name: "Event Name", ...AVATAR },
    });
    expect(result).not.toHaveProperty("suppressGroupTitle");
  });

  test("uses only an exact identity-store name when the event name is blank", () => {
    const owner = identity("assistant-a");
    const result = resolve({
      identity: owner,
      assistantName: "  ",
      identityStoreName: { identity: owner, name: "  Store Name  " },
      title: "Title Name",
    });

    expect(result).toMatchObject({
      presentation: "assistant",
      name: "Store Name",
      nameProvenance: "identity-store",
    });
    expect(result).not.toHaveProperty("suppressGroupTitle");
  });

  test("uses verified same-identity memory after unavailable direct names", () => {
    const owner = identity("assistant-a");
    const other = identity("assistant-b");
    const result = resolve({
      identity: owner,
      assistantName: null,
      identityStoreName: { identity: other, name: "Wrong Store Name" },
      verifiedSnapshot: {
        identity: owner,
        scopeEpoch: 1,
        identityRevision: 2,
        name: "  Memory Name  ",
        nameProvenance: "identity-store",
        avatar: AVATAR,
      },
      title: "Title Name",
    });

    expect(result).toMatchObject({
      presentation: "assistant",
      name: "Memory Name",
      nameProvenance: "verified-memory",
      sender: { id: owner.nativeSenderId, name: "Memory Name", ...AVATAR },
    });
  });

  test("does not treat an unproven memory name as verified", () => {
    const owner = identity("assistant-a");
    const result = resolve({
      identity: owner,
      verifiedSnapshot: {
        identity: owner,
        scopeEpoch: 1,
        identityRevision: 2,
        name: "Unproven Name",
      },
      title: "Title Name",
    });

    expect(result).toMatchObject({
      name: "Title Name",
      nameProvenance: "title",
      suppressGroupTitle: true,
    });
  });

  test("uses title only as a display fallback and explicitly suppresses its duplicate group title", () => {
    const result = resolve({
      assistantName: " ",
      identityStoreName: null,
      verifiedSnapshot: null,
      title: "  Finished task  ",
    });

    expect(result).toMatchObject({
      presentation: "assistant",
      name: "Finished task",
      nameProvenance: "title",
      suppressGroupTitle: true,
    });
  });

  test("falls back to app presentation only when every name and title is blank", () => {
    const owner = identity("assistant-a");
    const result = resolve({
      identity: owner,
      assistantName: " ",
      identityStoreName: { identity: owner, name: null },
      verifiedSnapshot: null,
      title: "\n\t",
    });

    expect(result).toEqual({ presentation: "app", identity: owner });
  });

  test("keeps assistant presentation for a valid name with a blank title", () => {
    const result = resolve({ assistantName: "Alice", title: " " });

    expect(result).toMatchObject({
      presentation: "assistant",
      name: "Alice",
      nameProvenance: "event",
    });
  });

  test("bounds the selected sender name", () => {
    const result = resolve({
      assistantName: `  ${"a".repeat(NOTIFICATION_SENDER_NAME_MAX_CHARS + 20)}  `,
    });

    expect(result).toMatchObject({
      presentation: "assistant",
      nameProvenance: "event",
    });
    expect(result.presentation === "assistant" ? result.name.length : 0).toBe(
      NOTIFICATION_SENDER_NAME_MAX_CHARS,
    );
  });

  test("does not publish a title fallback and adopts a later verified name", () => {
    const owner = identity("assistant-a");
    const first = resolve({ identity: owner, title: "Task finished" });
    expect(first).toMatchObject({
      name: "Task finished",
      nameProvenance: "title",
    });
    expect(getNotificationIdentitySnapshot(owner)).toBeNull();

    publishNotificationIdentitySnapshot({
      identity: owner,
      scopeEpoch: 0,
      identityRevision: 1,
      name: "Alice",
      nameProvenance: "event",
    });
    const second = resolve({
      identity: owner,
      verifiedSnapshot: getNotificationIdentitySnapshot(owner),
      title: "Task finished",
    });
    expect(second).toMatchObject({
      name: "Alice",
      nameProvenance: "verified-memory",
    });
    expect(second).not.toHaveProperty("suppressGroupTitle");
  });

  test("does not mistake an identical verified name and title for title provenance", () => {
    const owner = identity("assistant-a");
    const result = resolve({
      identity: owner,
      identityStoreName: { identity: owner, name: "Same Name" },
      title: "Same Name",
    });

    expect(result).toMatchObject({
      name: "Same Name",
      nameProvenance: "identity-store",
    });
    expect(result).not.toHaveProperty("suppressGroupTitle");
  });

  test("rejects a mixed-owner image without discarding a valid exact name", () => {
    const owner = identity("assistant-a");
    const otherOwner = identity("assistant-b");
    const result = resolve({
      identity: owner,
      identityStoreName: { identity: owner, name: "Alice" },
      verifiedSnapshot: {
        identity: otherOwner,
        scopeEpoch: 0,
        identityRevision: 0,
        name: "Bob",
        nameProvenance: "event",
        avatar: AVATAR,
      },
    });

    expect(result).toMatchObject({
      presentation: "assistant",
      name: "Alice",
      nameProvenance: "identity-store",
    });
    expect(result).not.toHaveProperty("sender");
  });

  test("rejects same-key memory carrying another native sender id", () => {
    const owner = identity("assistant-a");
    const staleMapping = identity(
      "assistant-a",
      owner.scopeId,
      "old-platform-assistant-a",
    );
    const result = resolve({
      identity: owner,
      assistantName: "Alice",
      verifiedSnapshot: {
        identity: staleMapping,
        scopeEpoch: 0,
        identityRevision: 0,
        avatar: AVATAR,
      },
    });

    expect(result).toMatchObject({ presentation: "assistant", name: "Alice" });
    expect(result).not.toHaveProperty("sender");
  });

  test("ignores warm sender data for an explicit app presentation", () => {
    const owner = identity("assistant-a");
    expect(
      resolve({
        presentation: "app",
        identity: owner,
        assistantName: "Alice",
        verifiedSnapshot: {
          identity: owner,
          scopeEpoch: 0,
          identityRevision: 0,
          name: "Alice",
          nameProvenance: "event",
          avatar: AVATAR,
        },
      }),
    ).toEqual({ presentation: "app", identity: owner });
  });

  test("never classifies presentation from sourceEventName", () => {
    const withSourceEventName = {
      presentation: "assistant" as const,
      identity: identity("assistant-a"),
      title: " ",
      sourceEventName: "Alice",
    };

    expect(resolveNotificationSender(withSourceEventName)).toEqual({
      presentation: "app",
      identity: withSourceEventName.identity,
    });
  });
});
