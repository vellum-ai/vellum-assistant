import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { NotificationIdentity } from "@vellumai/ipc-contract";

import {
  __clearNotificationIdentitySnapshotsForTests,
  beginNotificationIdentityPublication,
  clearNotificationAvatar,
  createNotificationIdentity,
  getNotificationAvatar,
  getNotificationIdentitySnapshot,
  NOTIFICATION_IDENTITY_SNAPSHOT_LIMIT,
  notificationIdentityKey,
  publishNotificationIdentitySnapshot,
  publishPreparedNotificationIdentity,
  reconcilePreparedNotificationIdentityOwners,
  resolveNotificationIdentityScope,
  resetPreparedNotificationIdentityByKey,
  resetPreparedNotificationScope,
  resetNotificationIdentitySnapshots,
  setNotificationAvatar,
  setNotificationIdentityNativeAdapter,
} from "@/runtime/notification-avatar";

const HASH = "a".repeat(64);
const AVATAR = { avatarBase64: "iVBORw==", avatarHash: HASH };
const PLATFORM_ASSISTANT_ID = "00000000-0000-4000-8000-000000000001";

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
  test("derives deterministic opaque SHA-256 scopes from canonical owners", () => {
    const connection = resolveNotificationIdentityScope({
      kind: "connection",
      url: "https://assistant.example.com/path?token=secret",
    });
    const sameOrigin = resolveNotificationIdentityScope({
      kind: "connection",
      url: "https://assistant.example.com/another-path",
    });
    const account = resolveNotificationIdentityScope({
      kind: "account",
      accountId: "user@example.com",
      organizationId: "org-abc",
    });

    expect(connection).toBe(
      "scope:v1:2bb3ad9851fe377a7de7dd843d37ef21c31438cf39a02346b51030456e4e7ce1",
    );
    expect(sameOrigin).toBe(connection);
    expect(account).toBe(
      "scope:v1:e6052e7a38013dfcdb9a2e8603679b2ab223f6b8f473611efd6b3128d860c426",
    );
    expect(account).not.toContain("user@example.com");
    expect(account).not.toContain("org-abc");
    expect(connection).not.toContain("assistant.example.com");
  });

  test("keeps platform sender ids and namespaces local ids unambiguously", () => {
    const platform = identity(
      "local-assistant",
      "connection:one",
      PLATFORM_ASSISTANT_ID,
    );
    const local = identity("self", "connection:one");
    const reloaded = identity("self", "connection:one");
    const otherConnection = identity("self", "connection:two");

    expect(platform.nativeSenderId).toBe(PLATFORM_ASSISTANT_ID);
    expect(local.nativeSenderId).toBe(reloaded.nativeSenderId);
    expect(local.nativeSenderId).not.toBe(otherConnection.nativeSenderId);
    expect(identity("c", "a:b").nativeSenderId).not.toBe(
      identity("b:c", "a").nativeSenderId,
    );
    expect(createNotificationIdentity(" ", "self")).toBeNull();
  });

  test("rejects a non-UUID platform sender id in the runtime constructor", () => {
    const invalidPlatform = identity(
      "assistant-a",
      "connection:one",
      "not-a-platform-uuid",
    );
    const local = identity("assistant-a", "connection:one");

    expect(invalidPlatform.nativeSenderId).toBe(local.nativeSenderId);
    expect(invalidPlatform.nativeSenderId).not.toBe("not-a-platform-uuid");
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
      PLATFORM_ASSISTANT_ID,
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

  test("reconciles removed owners and rejects their stale publications", () => {
    const retained = identity("assistant-a");
    const removed = identity("assistant-b");
    const retainedPublication = beginNotificationIdentityPublication(retained);
    const removedPublication = beginNotificationIdentityPublication(removed);
    for (const publication of [retainedPublication, removedPublication]) {
      expect(
        publishPreparedNotificationIdentity(publication, { avatar: AVATAR }),
      ).toBe(true);
    }

    expect(
      reconcilePreparedNotificationIdentityOwners([
        {
          scopeId: retained.scopeId,
          assistantId: retained.assistantId,
        },
      ]),
    ).toBe(1);
    expect(getNotificationIdentitySnapshot(retained)).not.toBeNull();
    expect(getNotificationIdentitySnapshot(removed)).toBeNull();
    expect(
      publishPreparedNotificationIdentity(removedPublication, {
        name: "Stale",
        nameProvenance: "identity-store",
      }),
    ).toBe(false);
    expect(
      reconcilePreparedNotificationIdentityOwners([
        {
          scopeId: retained.scopeId,
          assistantId: retained.assistantId,
        },
      ]),
    ).toBe(0);

    const restored = beginNotificationIdentityPublication(removed);
    expect(restored.identityRevision).toBeGreaterThan(
      removedPublication.identityRevision,
    );
    expect(
      publishPreparedNotificationIdentity(restored, {
        name: "Restored",
        nameProvenance: "identity-store",
      }),
    ).toBe(true);
  });

  test("reconcile force-clears a snapshot-only scope exactly once", () => {
    const scopeId = resolveNotificationIdentityScope({
      kind: "connection",
      url: "https://snapshot-only.example.com",
    })!;
    const snapshotOnly = identity("snapshot-only", scopeId);
    const resetIdentities = mock(() => {});
    setNotificationIdentityNativeAdapter({ resetIdentities });
    expect(
      publishNotificationIdentitySnapshot({
        identity: snapshotOnly,
        scopeEpoch: 0,
        identityRevision: 0,
        avatar: AVATAR,
      }),
    ).toBe(true);

    expect(reconcilePreparedNotificationIdentityOwners([])).toBe(1);
    expect(getNotificationIdentitySnapshot(snapshotOnly)).toBeNull();
    expect(resetIdentities).toHaveBeenCalledTimes(1);

    resetPreparedNotificationScope(scopeId);
    expect(resetIdentities).toHaveBeenCalledTimes(1);
  });

  test("scope-local publication pressure resets the scope before reusing guards", () => {
    const publications = Array.from(
      { length: NOTIFICATION_IDENTITY_SNAPSHOT_LIMIT * 2 + 1 },
      (_, index) =>
        beginNotificationIdentityPublication(
          identity(`assistant-${index}`, "scope:publication-pressure"),
        ),
    );
    for (const publication of publications) {
      publishPreparedNotificationIdentity(publication, { avatar: AVATAR });
    }

    const newest = publications.at(-1)!;
    expect(getNotificationIdentitySnapshot(newest.identity)).not.toBeNull();
    expect(
      getNotificationIdentitySnapshot(publications[0]!.identity),
    ).toBeNull();
    expect(
      publishPreparedNotificationIdentity(publications[0]!, {
        name: "Stale",
        nameProvenance: "identity-store",
      }),
    ).toBe(false);
    expect(newest.scopeEpoch).toBeGreaterThan(publications[0]!.scopeEpoch);
  });

  test("reset-by-key is idempotent after it seals an active generation", () => {
    const owner = identity("assistant-a");
    const publication = beginNotificationIdentityPublication(owner);
    publishPreparedNotificationIdentity(publication, { avatar: AVATAR });

    expect(
      resetPreparedNotificationIdentityByKey(
        owner.scopeId,
        owner.assistantId,
      ),
    ).toBe(true);
    expect(
      resetPreparedNotificationIdentityByKey(
        owner.scopeId,
        owner.assistantId,
      ),
    ).toBe(true);
    expect(
      publishPreparedNotificationIdentity(publication, { avatar: AVATAR }),
    ).toBe(false);
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
    resetNotificationIdentitySnapshots({
      scopeId: owner.scopeId,
      scopeEpoch: 4,
    });

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

  test("rejects a targeted reset older than the current identity", () => {
    const owner = identity("assistant-a");
    publishNotificationIdentitySnapshot({
      identity: owner,
      scopeEpoch: 2,
      identityRevision: 10,
      name: "Current",
      nameProvenance: "identity-store",
    });

    expect(
      resetNotificationIdentitySnapshots({
        scopeId: owner.scopeId,
        assistantId: owner.assistantId,
        scopeEpoch: 2,
        identityRevision: 5,
      }),
    ).toBe(false);
    expect(getNotificationIdentitySnapshot(owner)?.name).toBe("Current");
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

  test("seals a scope instead of forgetting identity generation floors", () => {
    const resetOwner = identity("assistant-a", "scope:sealed");
    const retainedOwner = identity("assistant-b", "scope:sealed");
    publishNotificationIdentitySnapshot({
      identity: retainedOwner,
      scopeEpoch: 2,
      identityRevision: 1,
      avatar: AVATAR,
    });
    resetNotificationIdentitySnapshots({
      scopeId: resetOwner.scopeId,
      assistantId: resetOwner.assistantId,
      scopeEpoch: 2,
      identityRevision: 10,
    });

    const churnScope = "scope:active";
    for (
      let index = 0;
      index < NOTIFICATION_IDENTITY_SNAPSHOT_LIMIT * 2 - 1;
      index++
    ) {
      publishNotificationIdentitySnapshot({
        identity: identity(`assistant-${index}`, churnScope),
        scopeEpoch: 0,
        identityRevision: 0,
        avatar: AVATAR,
      });
    }

    expect(getNotificationIdentitySnapshot(retainedOwner)).toBeNull();
    expect(
      publishNotificationIdentitySnapshot({
        identity: resetOwner,
        scopeEpoch: 2,
        identityRevision: 5,
        avatar: AVATAR,
      }),
    ).toBe(false);
    expect(
      publishNotificationIdentitySnapshot({
        identity: resetOwner,
        scopeEpoch: 3,
        identityRevision: 0,
        avatar: AVATAR,
      }),
    ).toBe(true);
    expect(
      publishNotificationIdentitySnapshot({
        identity: identity("assistant-0", churnScope),
        scopeEpoch: 0,
        identityRevision: 1,
        avatar: AVATAR,
      }),
    ).toBe(true);
  });

  test("fails closed when the scope generation budget is exhausted", () => {
    for (
      let index = 0;
      index < NOTIFICATION_IDENTITY_SNAPSHOT_LIMIT * 2;
      index++
    ) {
      expect(
        publishNotificationIdentitySnapshot({
          identity: identity("assistant-a", `scope:${index}`),
          scopeEpoch: 1,
          identityRevision: 0,
          avatar: AVATAR,
        }),
      ).toBe(true);
    }

    const rejected = identity("assistant-a", "scope:overflow");
    expect(
      publishNotificationIdentitySnapshot({
        identity: rejected,
        scopeEpoch: 1,
        identityRevision: 0,
        avatar: AVATAR,
      }),
    ).toBe(false);
    expect(
      publishNotificationIdentitySnapshot({
        identity: identity("assistant-a", "scope:0"),
        scopeEpoch: 1,
        identityRevision: 1,
        avatar: AVATAR,
      }),
    ).toBe(true);

    __clearNotificationIdentitySnapshotsForTests();
    expect(
      publishNotificationIdentitySnapshot({
        identity: rejected,
        scopeEpoch: 1,
        identityRevision: 0,
        avatar: AVATAR,
      }),
    ).toBe(true);
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
