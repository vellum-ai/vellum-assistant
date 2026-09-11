import { beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import type {
  NotificationIdentity,
  PrepareNotificationIdentityPayload,
} from "@vellumai/ipc-contract";

import {
  NOTIFICATION_IDENTITY_MEMORY_LIMIT,
  __resetNotificationIdentityMemoryForTesting,
  clearNotificationIdentityMemory,
  getPreparedNotificationIdentity,
  prepareNotificationIdentity,
  resetNotificationIdentities,
} from "./notification-identity-memory";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const HASH = createHash("sha256").update(PNG).digest("hex");
const SCOPE_A = `scope:v1:${"a".repeat(64)}`;

const scope = (index: number): string =>
  `scope:v1:${index.toString(16).padStart(64, "0")}`;

const identity = (
  assistantId = "assistant-a",
  scopeId = SCOPE_A,
): NotificationIdentity => ({
  scopeId,
  assistantId,
  nativeSenderId: `native-${assistantId}`,
});

const publication = (
  overrides: Partial<PrepareNotificationIdentityPayload> = {},
): PrepareNotificationIdentityPayload => ({
  identity: identity(),
  scopeEpoch: 1,
  identityRevision: 1,
  name: "Alice",
  nameProvenance: "identity-store",
  ...overrides,
});

beforeEach(() => {
  __resetNotificationIdentityMemoryForTesting();
});

describe("notification identity memory", () => {
  test("rejects a raw non-opaque scope before retaining identity data", () => {
    expect(
      prepareNotificationIdentity(
        publication({ identity: identity("assistant-a", "account-user-123") }),
      ),
    ).toBe(false);
    expect(
      resetNotificationIdentities({
        scopeId: "https://assistant.example.com",
        scopeEpoch: 2,
      }),
    ).toBe(false);
  });

  test("merges independently prepared verified names and avatars", () => {
    expect(prepareNotificationIdentity(publication())).toBe(true);
    expect(
      prepareNotificationIdentity(
        publication({
          name: undefined,
          nameProvenance: undefined,
          avatar: { avatarBase64: PNG.toString("base64"), avatarHash: HASH },
        }),
      ),
    ).toBe(true);

    expect(getPreparedNotificationIdentity(identity())).toMatchObject({
      identity: identity(),
      scopeEpoch: 1,
      identityRevision: 1,
      name: "Alice",
      nameProvenance: "identity-store",
      avatar: { avatarPng: PNG, avatarHash: HASH },
    });
  });

  test("rejects avatar bytes that do not match their hash", () => {
    expect(
      prepareNotificationIdentity(
        publication({
          name: undefined,
          nameProvenance: undefined,
          avatar: {
            avatarBase64: PNG.toString("base64"),
            avatarHash: "a".repeat(64),
          },
        }),
      ),
    ).toBe(false);
    expect(getPreparedNotificationIdentity(identity())).toBeNull();
  });

  test("never accepts title provenance as verified memory", () => {
    expect(
      prepareNotificationIdentity({
        ...publication(),
        name: "Conversation title",
        nameProvenance: "title" as never,
      }),
    ).toBe(false);
    expect(getPreparedNotificationIdentity(identity())).toBeNull();
  });

  test("requires an exact native sender id on lookup", () => {
    prepareNotificationIdentity(publication());

    expect(
      getPreparedNotificationIdentity({
        ...identity(),
        nativeSenderId: "foreign-native-id",
      }),
    ).toBeNull();
  });

  test("rejects a stale popout publication after a newer revision", () => {
    prepareNotificationIdentity(
      publication({ identityRevision: 5, name: "Current name" }),
    );

    expect(
      prepareNotificationIdentity(
        publication({ identityRevision: 4, name: "Stale name" }),
      ),
    ).toBe(false);
    expect(getPreparedNotificationIdentity(identity())?.name).toBe(
      "Current name",
    );
  });

  test("rejects stale revisions after a targeted reset", () => {
    prepareNotificationIdentity(publication({ identityRevision: 3 }));
    expect(
      resetNotificationIdentities({
        scopeId: SCOPE_A,
        scopeEpoch: 1,
        assistantId: "assistant-a",
        identityRevision: 4,
      }),
    ).toBe(true);

    expect(
      prepareNotificationIdentity(publication({ identityRevision: 4 })),
    ).toBe(false);
    expect(
      prepareNotificationIdentity(publication({ identityRevision: 5 })),
    ).toBe(true);
  });

  test("a targeted assistant reset leaves another prepared assistant intact", () => {
    const otherIdentity = identity("assistant-b");
    prepareNotificationIdentity(publication());
    prepareNotificationIdentity(
      publication({ identity: otherIdentity, identityRevision: 2 }),
    );

    resetNotificationIdentities({
      scopeId: SCOPE_A,
      scopeEpoch: 1,
      assistantId: "assistant-a",
      identityRevision: 3,
    });

    expect(getPreparedNotificationIdentity(identity())).toBeNull();
    expect(getPreparedNotificationIdentity(otherIdentity)?.name).toBe("Alice");
  });

  test("rejects an old epoch after a scope reset", () => {
    prepareNotificationIdentity(publication());
    expect(
      resetNotificationIdentities({ scopeId: SCOPE_A, scopeEpoch: 2 }),
    ).toBe(true);

    expect(prepareNotificationIdentity(publication())).toBe(false);
    expect(
      prepareNotificationIdentity(
        publication({ scopeEpoch: 2, identityRevision: 1 }),
      ),
    ).toBe(true);
  });

  test("sign-out clears bytes and seals every current scope epoch", () => {
    prepareNotificationIdentity(publication());

    clearNotificationIdentityMemory();

    expect(getPreparedNotificationIdentity(identity())).toBeNull();
    expect(prepareNotificationIdentity(publication())).toBe(false);
    expect(
      prepareNotificationIdentity(publication({ identityRevision: 2 })),
    ).toBe(false);
    expect(
      prepareNotificationIdentity(
        publication({ scopeEpoch: 2, identityRevision: 1 }),
      ),
    ).toBe(true);
  });

  test("bounds snapshots and keeps evicted identities exact", () => {
    for (let index = 0; index <= NOTIFICATION_IDENTITY_MEMORY_LIMIT; index++) {
      const currentIdentity = identity(`assistant-${index}`);
      expect(
        prepareNotificationIdentity(
          publication({ identity: currentIdentity, identityRevision: index }),
        ),
      ).toBe(true);
    }

    expect(getPreparedNotificationIdentity(identity("assistant-0"))).toBeNull();
    expect(
      getPreparedNotificationIdentity(
        identity(`assistant-${NOTIFICATION_IDENTITY_MEMORY_LIMIT}`),
      )?.name,
    ).toBe("Alice");
  });

  test("seals a scope when generation guards reach their bound", () => {
    for (let index = 0; index < NOTIFICATION_IDENTITY_MEMORY_LIMIT * 2; index++) {
      expect(
        prepareNotificationIdentity(
          publication({
            identity: identity(`assistant-${index}`),
            identityRevision: index,
          }),
        ),
      ).toBe(true);
    }

    expect(
      prepareNotificationIdentity(
        publication({ identity: identity("assistant-overflow") }),
      ),
    ).toBe(false);
    expect(
      getPreparedNotificationIdentity(
        identity(`assistant-${NOTIFICATION_IDENTITY_MEMORY_LIMIT * 2 - 1}`),
      ),
    ).toBeNull();
    expect(
      prepareNotificationIdentity(
        publication({
          identity: identity("assistant-recovered"),
          scopeEpoch: 2,
        }),
      ),
    ).toBe(true);
  });

  test("fails closed when the bounded scope guard set is full", () => {
    for (let index = 0; index < NOTIFICATION_IDENTITY_MEMORY_LIMIT * 2; index++) {
      expect(
        prepareNotificationIdentity(
          publication({
            identity: identity("assistant-a", scope(index)),
          }),
        ),
      ).toBe(true);
    }

    expect(
      prepareNotificationIdentity(
        publication({
          identity: identity(
            "assistant-a",
            `scope:v1:${"f".repeat(64)}`,
          ),
        }),
      ),
    ).toBe(false);
  });
});
