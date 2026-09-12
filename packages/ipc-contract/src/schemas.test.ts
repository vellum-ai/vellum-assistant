/**
 * The notification payload's boundary behaviour. `handle()` in
 * `@vellumai/electron-desktop` parses this payload and a throw rejects the
 * renderer's `invoke`, so what the schema does with a bad `sender` decides
 * whether the user sees a plain banner or none at all.
 */
import { describe, expect, test } from "bun:test";

import {
  prepareNotificationIdentityPayloadSchema,
  registerNotificationIdentityPublisherPayloadSchema,
  resetNotificationIdentitiesPayloadSchema,
  showNotificationPayloadSchema,
} from "./schemas";
import {
  NOTIFICATION_AVATAR_BASE64_MAX_CHARS,
  NOTIFICATION_DELIVERY_KEY_MAX_CHARS,
  NOTIFICATION_AVATAR_HASH_PATTERN,
  resolveNotificationDeliveryKey,
} from "./types";

const HASH = "a".repeat(64);

const payload = (sender?: unknown) => ({
  category: "activityComplete",
  title: "Done",
  body: "The task finished",
  conversationId: "conv-1",
  ...(sender === undefined ? {} : { sender }),
});

const SENDER = {
  id: "assistant-1",
  name: "Ada",
  avatarBase64: "iVBORw==",
  avatarHash: HASH,
};

const IDENTITY = {
  scopeId: "user:user-123:org:org-abc",
  assistantId: "assistant-1",
  nativeSenderId: "assistant-1",
};

describe("showNotificationPayloadSchema", () => {
  test("keeps a well-formed sender", () => {
    expect(showNotificationPayloadSchema.parse(payload(SENDER))).toMatchObject({
      title: "Done",
      sender: SENDER,
    });
  });

  test("parses a payload with no sender at all", () => {
    expect(
      showNotificationPayloadSchema.parse(payload()).sender,
    ).toBeUndefined();
  });

  test("keeps scoped identity and presentation metadata", () => {
    const parsed = showNotificationPayloadSchema.parse({
      ...payload(SENDER),
      presentation: "assistant",
      identity: IDENTITY,
      nameProvenance: "event",
      correlationId: "delivery-full-key",
      suppressGroupTitle: false,
    });

    expect(parsed).toMatchObject({
      presentation: "assistant",
      identity: IDENTITY,
      nameProvenance: "event",
      correlationId: "delivery-full-key",
      suppressGroupTitle: false,
    });
  });

  test("keeps legacy explicit sender decoration", () => {
    const parsed = showNotificationPayloadSchema.parse(payload(SENDER));

    expect(parsed.presentation).toBeUndefined();
    expect(parsed.identity).toBeUndefined();
    expect(parsed.sender).toEqual(SENDER);
  });

  test("allows app presentation with scoped and inline sender data", () => {
    const parsed = showNotificationPayloadSchema.parse({
      ...payload(SENDER),
      presentation: "app",
      identity: IDENTITY,
    });

    expect(parsed.presentation).toBe("app");
    expect(parsed.sender).toEqual(SENDER);
  });

  test.each([
    ["a hash that is not 64 lowercase hex", { ...SENDER, avatarHash: "abc" }],
    ["an uppercase hash", { ...SENDER, avatarHash: HASH.toUpperCase() }],
    ["a path traversal in the hash", { ...SENDER, avatarHash: "../../escape" }],
    [
      "a missing name",
      { id: "assistant-1", avatarBase64: "x", avatarHash: HASH },
    ],
    ["a sender that is not an object", "assistant-1"],
    ["invalid base64", { ...SENDER, avatarBase64: "****" }],
    [
      "an avatar past the byte cap",
      {
        ...SENDER,
        avatarBase64: "A".repeat(NOTIFICATION_AVATAR_BASE64_MAX_CHARS + 1),
      },
    ],
  ])("degrades to no sender for %s", (_label, sender) => {
    const parsed = showNotificationPayloadSchema.parse(payload(sender));

    expect(parsed.sender).toBeUndefined();
    expect(parsed).toMatchObject({
      category: "activityComplete",
      title: "Done",
      body: "The task finished",
      conversationId: "conv-1",
    });
  });

  test("still rejects a payload whose own fields are malformed", () => {
    expect(() =>
      showNotificationPayloadSchema.parse({
        ...payload(SENDER),
        category: "nope",
      }),
    ).toThrow();
  });

  test("rejects partial scoped identity", () => {
    expect(() =>
      showNotificationPayloadSchema.parse({
        ...payload(),
        presentation: "assistant",
        identity: { scopeId: "scope", assistantId: "assistant-1" },
      }),
    ).toThrow();
  });

  test("rejects a sender owned by another routing identity", () => {
    expect(() =>
      showNotificationPayloadSchema.parse({
        ...payload(SENDER),
        presentation: "assistant",
        identity: { ...IDENTITY, nativeSenderId: "assistant-2" },
      }),
    ).toThrow();
  });

  test("rejects invalid presentation and inconsistent title hints", () => {
    expect(() =>
      showNotificationPayloadSchema.parse({
        ...payload(),
        presentation: "person",
      }),
    ).toThrow();
    expect(() =>
      showNotificationPayloadSchema.parse({
        ...payload(),
        presentation: "assistant",
        identity: IDENTITY,
        nameProvenance: "event",
        suppressGroupTitle: true,
      }),
    ).toThrow();
  });

  test("bounds delivery keys without changing the legacy optional shape", () => {
    expect(
      showNotificationPayloadSchema.parse({
        ...payload(),
        deliveryId: "",
      }).deliveryId,
    ).toBe("");
    expect(() =>
      showNotificationPayloadSchema.parse({
        ...payload(),
        requestKey: "x".repeat(NOTIFICATION_DELIVERY_KEY_MAX_CHARS + 1),
      }),
    ).toThrow();
  });
});

describe("prepared notification identity schemas", () => {
  test("accepts bounded name and avatar publications", () => {
    expect(
      prepareNotificationIdentityPayloadSchema.parse({
        identity: IDENTITY,
        scopeEpoch: 2,
        identityRevision: 4,
        publisherSessionId: "session-a",
        name: "Ada",
        nameProvenance: "identity-store",
        avatar: {
          avatarBase64: SENDER.avatarBase64,
          avatarHash: HASH,
        },
      }),
    ).toMatchObject({
      identity: IDENTITY,
      scopeEpoch: 2,
      identityRevision: 4,
      publisherSessionId: "session-a",
    });
  });

  test("requires content and verified provenance for a prepared name", () => {
    expect(() =>
      prepareNotificationIdentityPayloadSchema.parse({
        identity: IDENTITY,
        scopeEpoch: 0,
        identityRevision: 0,
      }),
    ).toThrow();
    expect(() =>
      prepareNotificationIdentityPayloadSchema.parse({
        identity: IDENTITY,
        scopeEpoch: 0,
        identityRevision: 0,
        name: "Ada",
      }),
    ).toThrow();
    expect(() =>
      prepareNotificationIdentityPayloadSchema.parse({
        identity: IDENTITY,
        scopeEpoch: 0,
        identityRevision: 0,
        name: "Done",
        nameProvenance: "title",
      }),
    ).toThrow();
  });

  test("accepts scoped reset for one assistant or the whole scope", () => {
    expect(
      resetNotificationIdentitiesPayloadSchema.parse({
        scopeId: IDENTITY.scopeId,
        scopeEpoch: 3,
      }),
    ).toEqual({ scopeId: IDENTITY.scopeId, scopeEpoch: 3 });
    expect(
      resetNotificationIdentitiesPayloadSchema.parse({
        scopeId: IDENTITY.scopeId,
        scopeEpoch: 3,
        assistantId: IDENTITY.assistantId,
        identityRevision: 5,
      }).assistantId,
    ).toBe(IDENTITY.assistantId);
    expect(() =>
      resetNotificationIdentitiesPayloadSchema.parse({
        scopeId: IDENTITY.scopeId,
        scopeEpoch: 3,
        identityRevision: 5,
      }),
    ).toThrow();
  });

  test("requires a bounded publisher session registration", () => {
    expect(
      registerNotificationIdentityPublisherPayloadSchema.parse({
        publisherSessionId: "session-a",
      }),
    ).toEqual({ publisherSessionId: "session-a" });
    expect(() =>
      registerNotificationIdentityPublisherPayloadSchema.parse({
        publisherSessionId: " ",
      }),
    ).toThrow();
  });
});

describe("resolveNotificationDeliveryKey", () => {
  test("uses the full correlation, delivery, then stable request key", () => {
    expect(
      resolveNotificationDeliveryKey({
        correlationId: "  correlation-full  ",
        deliveryId: "delivery-full",
        requestKey: "request-full",
      }),
    ).toBe("correlation-full");
    expect(
      resolveNotificationDeliveryKey({
        correlationId: " ",
        deliveryId: "delivery-full",
        requestKey: "request-full",
      }),
    ).toBe("delivery-full");
    expect(resolveNotificationDeliveryKey({ requestKey: "request-full" })).toBe(
      "request-full",
    );
    expect(resolveNotificationDeliveryKey({})).toBeNull();
  });
});

describe("the notification avatar bounds", () => {
  test("accepts a lowercase hex SHA-256 and nothing else", () => {
    expect(NOTIFICATION_AVATAR_HASH_PATTERN.test(HASH)).toBe(true);
    for (const value of ["", "abc", HASH.toUpperCase(), `${HASH}0`, "../x"]) {
      expect(NOTIFICATION_AVATAR_HASH_PATTERN.test(value)).toBe(false);
    }
  });
});
