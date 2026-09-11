import { beforeEach, describe, expect, test } from "bun:test";

import type { NotificationIdentity } from "@vellumai/ipc-contract";

import {
  __clearNotificationIdentitySnapshotsForTests,
  clearNotificationAvatar,
  createNotificationIdentity,
  getNotificationAvatar,
  getNotificationIdentitySnapshot,
  NOTIFICATION_IDENTITY_SNAPSHOT_LIMIT,
  notificationIdentityKey,
  publishNotificationIdentitySnapshot,
  resetNotificationIdentitySnapshots,
  setNotificationAvatar,
} from "@/runtime/notification-avatar";

const HASH = "a".repeat(64);
const AVATAR = { avatarBase64: "iVBORw==", avatarHash: HASH };

function identity(
  assistantId: string,
  scopeId = "connection:one",
  platformAssistantId?: string,
): NotificationIdentity {
  const result = createNotificationIdentity(
    scopeId,
    assistantId,
    platformAssistantId,
  );
  if (!result) {
    throw new Error("test identity must be valid");
  }
  return result;
}

beforeEach(() => {
  __clearNotificationIdentitySnapshotsForTests();
  clearNotificationAvatar();
});

describe("notification identities", () => {
  test("keeps platform sender ids and namespaces local ids unambiguously", () => {
    const platform = identity(
      "local-assistant",
      "connection:one",
      "platform-assistant-1",
    );
    const local = identity("self", "connection:one");
    const reloaded = identity("self", "connection:one");
    const otherConnection = identity("self", "connection:two");

    expect(platform.nativeSenderId).toBe("platform-assistant-1");
    expect(local.nativeSenderId).toBe(reloaded.nativeSenderId);
    expect(local.nativeSenderId).not.toBe(otherConnection.nativeSenderId);
    expect(identity("c", "a:b").nativeSenderId).not.toBe(
      identity("b:c", "a").nativeSenderId,
    );
    expect(createNotificationIdentity(" ", "self")).toBeNull();
  });

  test("uses scope and assistant together as the snapshot owner", () => {
    const assistantA = identity("assistant-a");
    const assistantB = identity("assistant-b");
    const selfOnAnotherConnection = identity("assistant-a", "connection:two");

    expect(
      publishNotificationIdentitySnapshot({
        identity: assistantA,
        scopeEpoch: 0,
        identityRevision: 1,
        name: "  Alice  ",
        nameProvenance: "identity-store",
      }),
    ).toBe(true);
    expect(
      publishNotificationIdentitySnapshot({
        identity: assistantB,
        scopeEpoch: 0,
        identityRevision: 1,
        name: "Bob",
        nameProvenance: "event",
      }),
    ).toBe(true);

    expect(getNotificationIdentitySnapshot(assistantA)?.name).toBe("Alice");
    expect(getNotificationIdentitySnapshot(assistantB)?.name).toBe("Bob");
    expect(getNotificationIdentitySnapshot(selfOnAnotherConnection)).toBeNull();
    expect(notificationIdentityKey(assistantA)).not.toBe(
      notificationIdentityKey(selfOnAnotherConnection),
    );
  });

  test("merges independent fields and updates a renamed name when the hash is unchanged", () => {
    const owner = identity("assistant-a");

    publishNotificationIdentitySnapshot({
      identity: owner,
      scopeEpoch: 2,
      identityRevision: 4,
      name: "Alice",
      nameProvenance: "identity-store",
      avatar: AVATAR,
    });
    expect(
      publishNotificationIdentitySnapshot({
        identity: owner,
        scopeEpoch: 2,
        identityRevision: 5,
        name: "Alicia",
        nameProvenance: "event",
      }),
    ).toBe(true);

    expect(getNotificationIdentitySnapshot(owner)).toMatchObject({
      name: "Alicia",
      nameProvenance: "event",
      avatar: AVATAR,
      identityRevision: 5,
    });
  });

  test("keeps a valid field when its sibling update is malformed", () => {
    const owner = identity("assistant-a");
    publishNotificationIdentitySnapshot({
      identity: owner,
      scopeEpoch: 0,
      identityRevision: 1,
      avatar: AVATAR,
    });

    expect(
      publishNotificationIdentitySnapshot({
        identity: owner,
        scopeEpoch: 0,
        identityRevision: 2,
        name: "Alicia",
        nameProvenance: "identity-store",
        avatar: { avatarBase64: "not base64", avatarHash: "bad" },
      }),
    ).toBe(true);
    expect(getNotificationIdentitySnapshot(owner)).toMatchObject({
      name: "Alicia",
      avatar: AVATAR,
      identityRevision: 2,
    });
  });

  test("rejects stale revisions and accepts a newer native sender mapping", () => {
    const localOwner = identity("assistant-a");
    const platformOwner = identity(
      "assistant-a",
      "connection:one",
      "platform-assistant-a",
    );
    publishNotificationIdentitySnapshot({
      identity: localOwner,
      scopeEpoch: 1,
      identityRevision: 4,
      name: "Current",
      nameProvenance: "event",
      avatar: AVATAR,
    });

    expect(
      publishNotificationIdentitySnapshot({
        identity: platformOwner,
        scopeEpoch: 1,
        identityRevision: 3,
        name: "Stale",
        nameProvenance: "event",
      }),
    ).toBe(false);
    expect(getNotificationIdentitySnapshot(localOwner)?.name).toBe("Current");

    expect(
      publishNotificationIdentitySnapshot({
        identity: platformOwner,
        scopeEpoch: 1,
        identityRevision: 5,
        name: "Mapped",
        nameProvenance: "identity-store",
      }),
    ).toBe(true);
    expect(getNotificationIdentitySnapshot(localOwner)).toBeNull();
    expect(getNotificationIdentitySnapshot(platformOwner)).toMatchObject({
      name: "Mapped",
    });
    expect(getNotificationIdentitySnapshot(platformOwner)).not.toHaveProperty(
      "avatar",
    );
  });

  test("resets one owner without clearing its sibling", () => {
    const assistantA = identity("assistant-a");
    const assistantB = identity("assistant-b");
    for (const owner of [assistantA, assistantB]) {
      publishNotificationIdentitySnapshot({
        identity: owner,
        scopeEpoch: 0,
        identityRevision: 1,
        avatar: AVATAR,
      });
    }

    expect(
      resetNotificationIdentitySnapshots({
        scopeId: assistantA.scopeId,
        assistantId: assistantA.assistantId,
        scopeEpoch: 0,
      }),
    ).toBe(true);
    expect(getNotificationIdentitySnapshot(assistantA)).toBeNull();
    expect(getNotificationIdentitySnapshot(assistantB)).not.toBeNull();
    expect(
      publishNotificationIdentitySnapshot({
        identity: assistantA,
        scopeEpoch: 0,
        identityRevision: 1,
        avatar: AVATAR,
      }),
    ).toBe(false);
    expect(
      publishNotificationIdentitySnapshot({
        identity: assistantA,
        scopeEpoch: 0,
        identityRevision: 2,
        avatar: AVATAR,
      }),
    ).toBe(true);
  });

  test("a scope reset rejects late publication and accepts its current epoch", () => {
    const owner = identity("assistant-a");
    const sibling = identity("assistant-b");
    const otherScope = identity("assistant-a", "connection:two");
    publishNotificationIdentitySnapshot({
      identity: owner,
      scopeEpoch: 3,
      identityRevision: 2,
      avatar: AVATAR,
    });
    for (const retainedOwner of [sibling, otherScope]) {
      publishNotificationIdentitySnapshot({
        identity: retainedOwner,
        scopeEpoch: 3,
        identityRevision: 2,
        avatar: AVATAR,
      });
    }
    resetNotificationIdentitySnapshots({ scopeId: owner.scopeId, scopeEpoch: 4 });

    expect(getNotificationIdentitySnapshot(owner)).toBeNull();
    expect(getNotificationIdentitySnapshot(sibling)).toBeNull();
    expect(getNotificationIdentitySnapshot(otherScope)).not.toBeNull();
    expect(
      publishNotificationIdentitySnapshot({
        identity: owner,
        scopeEpoch: 3,
        identityRevision: 99,
        avatar: AVATAR,
      }),
    ).toBe(false);
    expect(
      publishNotificationIdentitySnapshot({
        identity: owner,
        scopeEpoch: 4,
        identityRevision: 0,
        avatar: AVATAR,
      }),
    ).toBe(true);
  });

  test("makes sibling snapshots unreadable when the scope epoch advances", () => {
    const assistantA = identity("assistant-a");
    const assistantB = identity("assistant-b");
    for (const owner of [assistantA, assistantB]) {
      publishNotificationIdentitySnapshot({
        identity: owner,
        scopeEpoch: 1,
        identityRevision: 4,
        avatar: AVATAR,
      });
    }

    publishNotificationIdentitySnapshot({
      identity: assistantA,
      scopeEpoch: 2,
      identityRevision: 0,
      name: "Fresh",
      nameProvenance: "identity-store",
    });

    expect(getNotificationIdentitySnapshot(assistantA)?.name).toBe("Fresh");
    expect(getNotificationIdentitySnapshot(assistantB)).toBeNull();
  });

  test("uses an explicit targeted revision as the same-epoch tombstone", () => {
    const owner = identity("assistant-a");
    expect(
      resetNotificationIdentitySnapshots({
        scopeId: owner.scopeId,
        assistantId: owner.assistantId,
        scopeEpoch: 2,
        identityRevision: 8,
      }),
    ).toBe(true);
    expect(
      publishNotificationIdentitySnapshot({
        identity: owner,
        scopeEpoch: 2,
        identityRevision: 8,
        avatar: AVATAR,
      }),
    ).toBe(false);
    expect(
      publishNotificationIdentitySnapshot({
        identity: owner,
        scopeEpoch: 2,
        identityRevision: 9,
        avatar: AVATAR,
      }),
    ).toBe(true);
  });

  test("starts the revision floor over when a targeted reset advances the scope epoch", () => {
    const owner = identity("assistant-a");
    publishNotificationIdentitySnapshot({
      identity: owner,
      scopeEpoch: 2,
      identityRevision: 12,
      avatar: AVATAR,
    });

    expect(
      resetNotificationIdentitySnapshots({
        scopeId: owner.scopeId,
        assistantId: owner.assistantId,
        scopeEpoch: 3,
      }),
    ).toBe(true);
    expect(
      publishNotificationIdentitySnapshot({
        identity: owner,
        scopeEpoch: 3,
        identityRevision: 0,
        name: "Fresh",
        nameProvenance: "identity-store",
      }),
    ).toBe(true);
    expect(getNotificationIdentitySnapshot(owner)).toMatchObject({
      scopeEpoch: 3,
      identityRevision: 0,
      name: "Fresh",
    });
  });

  test("evicts the least recently used snapshot at the RAM bound", () => {
    const owners = Array.from(
      { length: NOTIFICATION_IDENTITY_SNAPSHOT_LIMIT + 1 },
      (_, index) => identity(`assistant-${index}`),
    );
    for (const owner of owners.slice(0, NOTIFICATION_IDENTITY_SNAPSHOT_LIMIT)) {
      publishNotificationIdentitySnapshot({
        identity: owner,
        scopeEpoch: 0,
        identityRevision: 0,
        avatar: AVATAR,
      });
    }
    expect(getNotificationIdentitySnapshot(owners[0]!)).not.toBeNull();
    publishNotificationIdentitySnapshot({
      identity: owners.at(-1)!,
      scopeEpoch: 0,
      identityRevision: 0,
      avatar: AVATAR,
    });

    expect(getNotificationIdentitySnapshot(owners[0]!)).not.toBeNull();
    expect(getNotificationIdentitySnapshot(owners[1]!)).toBeNull();
    expect(getNotificationIdentitySnapshot(owners.at(-1)!)).not.toBeNull();
  });
});

describe("legacy notification avatar accessors", () => {
  test("retain the existing singleton contract during adoption", () => {
    setNotificationAvatar("assistant-a", new Uint8Array([1, 2, 3]), HASH);
    expect(getNotificationAvatar()).toEqual({
      assistantId: "assistant-a",
      avatarBase64: "AQID",
      avatarHash: HASH,
    });

    clearNotificationAvatar();
    expect(getNotificationAvatar()).toBeNull();
  });
});
