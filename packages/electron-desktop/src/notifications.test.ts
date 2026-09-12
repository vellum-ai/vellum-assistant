import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

import type { z } from "zod";

/**
 * Unit coverage for the main-process notification bridge added in LUM-1873.
 *
 * The OS-delivery half (does macOS actually render a banner + buttons)
 * cannot be exercised off a signed/notarized build, so these tests pin the
 * platform-independent logic instead: category -> action-button mapping
 * (Swift-parity labels), dedup/cooldown, the real delivery-outcome ack
 * (resolve on `show`/`failed`/timeout — never optimistic), and the
 * click/action broadcast contract the renderer consumes.
 *
 * `electron` and `./presence-runtime` are mocked so the module can be
 * imported and driven without an Electron runtime, and the per-client seams
 * (`ensureVisible`, notification factory) are injected through
 * `configureNotifications`. Each test file runs in its own process (see
 * `scripts/run-isolated-tests.ts`), so these per-file `mock.module`
 * overrides don't leak.
 */

// --- Mock: electron (Notification + BrowserWindow) -------------------------

interface MockNotificationOptions {
  title: string;
  body: string;
  silent: boolean;
  actions: Array<{ type: "button"; text: string }>;
  icon?: unknown;
}

/**
 * Controls what the mocked `.show()` simulates the OS doing:
 *   "show"   -> fires the `show` event (delivered)
 *   "failed" -> fires the `failed` event (rejected)
 *   "none"   -> fires nothing (delivery never confirmed -> timeout path)
 */
let deliveryOutcome: "show" | "failed" | "none" = "show";
let notificationSupported = true;
const constructed: MockNotification[] = [];

class MockNotification {
  readonly options: MockNotificationOptions;
  private readonly handlers: Record<
    string,
    Array<(...args: unknown[]) => void>
  > = {};
  shown = false;

  constructor(options: MockNotificationOptions) {
    this.options = options;
    constructed.push(this);
  }

  static isSupported(): boolean {
    return notificationSupported;
  }

  on(event: string, cb: (...args: unknown[]) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers[event] ?? []) cb(...args);
  }

  show(): void {
    this.shown = true;
    if (deliveryOutcome === "show") {
      this.emit("show");
    } else if (deliveryOutcome === "failed") {
      // Electron delivers the `failed` error as a string description.
      this.emit("failed", {}, "UNErrorDomain error 1");
    }
    // "none" intentionally fires nothing so the delivery timeout fires.
  }
}

const sentMessages: Array<{ channel: string; payload: unknown }> = [];

/** Tagged stand-in for a decoded `NativeImage`, so a test can read its bytes. */
const createFromBufferMock = mock((buffer: Buffer) => ({
  nativeImageOf: buffer,
}));

mock.module("electron", () => ({
  Notification: MockNotification,
  nativeImage: { createFromBuffer: createFromBufferMock },
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            sentMessages.push({ channel, payload });
          },
        },
      },
    ],
  },
}));

// --- Injected runtime seams (IPC registrar + ensureVisible spies) ----------

type HandleRegistration = {
  channel: string;
  schema: z.ZodType<unknown[]>;
  fn: (args: unknown[], event?: unknown) => unknown;
};
const handleRegistrations: HandleRegistration[] = [];
const handleMock = mock(
  (
    channel: string,
    schema: z.ZodType<unknown[]>,
    fn: (args: unknown[], event?: unknown) => unknown,
  ) => {
    handleRegistrations.push({ channel, schema, fn });
  },
);
const ipc = {
  handle: handleMock as unknown as import("./ipc").IpcHandle,
};
const quietLogger = { warn: () => undefined };
const ensureVisibleMock = mock(() => Promise.resolve());

const {
  configureNotifications,
  installNotifications,
  NOTIFICATION_CATEGORIES,
  __resetForTesting,
  __setDeliveryTimeoutForTesting,
  isPreparedNotificationSenderCurrent,
} = await import("./notifications");

type NotificationCreateOptions =
  import("./notifications").NotificationCreateOptions;
type NotificationLike = import("./notifications").NotificationLike;

// --- Helpers ---------------------------------------------------------------

const SHOW_CHANNEL = "vellum:notifications:show";
const ACTION_CHANNEL = "vellum:notifications:action";
const REGISTER_PUBLISHER_CHANNEL =
  "vellum:notifications:registerIdentityPublisher";
const PREPARE_CHANNEL = "vellum:notifications:prepareIdentity";
const RESET_CHANNEL = "vellum:notifications:resetIdentities";
const OPAQUE_SCOPE_A = `scope:v1:${"a".repeat(64)}`;
const OPAQUE_SCOPE_B = `scope:v1:${"b".repeat(64)}`;
const defaultSender = {
  id: 1,
  once: () => undefined,
};
const defaultEvent = { sender: defaultSender };

interface ShowResult {
  success: boolean;
  errorMessage?: string;
}

const showHandler = (): HandleRegistration => {
  const reg = handleRegistrations.find((r) => r.channel === SHOW_CHANNEL);
  if (!reg) throw new Error(`no handler registered for ${SHOW_CHANNEL}`);
  return reg;
};

const handlerFor = (channel: string): HandleRegistration => {
  const registration = handleRegistrations.find(
    (candidate) => candidate.channel === channel,
  );
  if (!registration) {
    throw new Error(`no handler registered for ${channel}`);
  }
  return registration;
};

const prepareIdentity = (payload: Record<string, unknown>): void => {
  const { schema, fn } = handlerFor(PREPARE_CHANNEL);
  fn(schema.parse([payload]), defaultEvent);
};

const resetIdentities = (payload: Record<string, unknown>): void => {
  const { schema, fn } = handlerFor(RESET_CHANNEL);
  fn(schema.parse([payload]), defaultEvent);
};

/** Invoke the registered show handler the way `./ipc` would (tuple arg). */
const show = (payload: Record<string, unknown>): Promise<ShowResult> =>
  showHandler().fn([payload]) as Promise<ShowResult>;

/** The same, through the boundary schema, for what the parse itself decides. */
const showParsed = (payload: Record<string, unknown>): Promise<ShowResult> => {
  const { schema, fn } = showHandler();
  return fn(schema.parse([payload])) as Promise<ShowResult>;
};

/** What the boundary hands the handler, for asserting on what survived it. */
const parseShowPayload = (
  payload: Record<string, unknown>,
): Record<string, unknown> =>
  showHandler().schema.parse([payload])[0] as Record<string, unknown>;

const BASE_TIME = new Date("2026-06-05T12:00:00.000Z").getTime();
const at = (msOffset: number) => setSystemTime(new Date(BASE_TIME + msOffset));

beforeEach(() => {
  __resetForTesting();
  deliveryOutcome = "show";
  notificationSupported = true;
  constructed.length = 0;
  sentMessages.length = 0;
  handleRegistrations.length = 0;
  handleMock.mockClear();
  ensureVisibleMock.mockClear();
  createFromBufferMock.mockClear();
  at(0);
  configureNotifications({
    ipc,
    ensureVisible: ensureVisibleMock,
    logger: quietLogger,
  });
  installNotifications();
});

afterEach(() => {
  __resetForTesting();
  setSystemTime(); // restore real clock
});

// --- IPC contract ----------------------------------------------------------

describe("installNotifications", () => {
  test("registers the show handler on the notifications channel", () => {
    expect(handleRegistrations.map((r) => r.channel)).toContain(SHOW_CHANNEL);
  });

  test("registers validated identity preparation and reset handlers", () => {
    expect(handleRegistrations.map((r) => r.channel)).toEqual(
      expect.arrayContaining([
        REGISTER_PUBLISHER_CHANNEL,
        PREPARE_CHANNEL,
        RESET_CHANNEL,
      ]),
    );
    expect(() =>
      handlerFor(PREPARE_CHANNEL).schema.parse([
        {
          identity: {
            scopeId: OPAQUE_SCOPE_A,
            assistantId: "assistant-a",
            nativeSenderId: "native-a",
          },
          scopeEpoch: -1,
          identityRevision: 1,
          name: "Alice",
          nameProvenance: "identity-store",
        },
      ]),
    ).toThrow();
    expect(() =>
      handlerFor(RESET_CHANNEL).schema.parse([
        { scopeId: OPAQUE_SCOPE_A, scopeEpoch: 1, identityRevision: 2 },
      ]),
    ).toThrow();
  });

  test("the captured schema accepts a valid payload and rejects an unknown category", () => {
    const { schema } = showHandler();
    expect(() =>
      schema.parse([{ category: "notificationIntent", title: "t", body: "b" }]),
    ).not.toThrow();
    expect(() =>
      schema.parse([{ category: "not-a-category", title: "t", body: "b" }]),
    ).toThrow();
  });
});

// --- Category -> action buttons (Swift-parity labels) ----------------------

describe("category action buttons", () => {
  // Labels mirror the Swift client's UNNotificationCategory registrations.
  const expected: Record<string, string[]> = {
    activityComplete: ["View Results"],
    toolConfirmation: ["Allow", "Deny"],
    voiceResponseComplete: ["View Response"],
    notificationIntent: ["View"],
  };

  for (const category of NOTIFICATION_CATEGORIES) {
    test(`${category} posts the expected buttons`, async () => {
      const result = await show({
        category,
        title: "T",
        body: "B",
        deliveryId: `id-${category}`,
      });
      expect(result.success).toBe(true);
      expect(constructed).toHaveLength(1);
      expect(constructed[0]!.options.actions.map((a) => a.text)).toEqual(
        expected[category]!,
      );
    });
  }
});

// --- Dedup / cooldown ------------------------------------------------------

describe("dedup / cooldown", () => {
  test("suppresses a duplicate notificationIntent within the cooldown window, then fires again after it elapses", async () => {
    const payload = {
      category: "notificationIntent",
      title: "T",
      body: "B",
      deliveryId: "dup-1",
    };

    at(0);
    expect((await show(payload)).success).toBe(true);
    expect(constructed).toHaveLength(1);

    // 5s later — still inside the 10s notificationIntent cooldown.
    at(5_000);
    const suppressed = await show(payload);
    expect(suppressed.success).toBe(true); // treated as delivered
    expect(constructed).toHaveLength(1); // but nothing new posted

    // 11s after the first — cooldown elapsed, posts again.
    at(11_000);
    expect((await show(payload)).success).toBe(true);
    expect(constructed).toHaveLength(2);
  });

  test("toolConfirmation has no cooldown and always posts", async () => {
    const payload = {
      category: "toolConfirmation",
      title: "T",
      body: "B",
      deliveryId: "tool-1",
    };
    at(0);
    await show(payload);
    at(1); // 1ms later
    await show(payload);
    expect(constructed).toHaveLength(2);
  });

  test("uses correlation, delivery, then request identifier precedence", async () => {
    const scopedIdentity = {
      scopeId: OPAQUE_SCOPE_A,
      assistantId: "assistant-a",
      nativeSenderId: "native-a",
    };
    await show({
      category: "notificationIntent",
      title: "First copy",
      body: "First body",
      correlationId: "correlation-a",
      deliveryId: "delivery-a",
      requestKey: "request-a",
      presentation: "app",
      identity: scopedIdentity,
    });
    await show({
      category: "notificationIntent",
      title: "Changed copy",
      body: "Changed body",
      correlationId: "correlation-a",
      deliveryId: "delivery-b",
      requestKey: "request-b",
      presentation: "app",
      identity: scopedIdentity,
    });
    await show({
      category: "notificationIntent",
      title: "Third copy",
      body: "Third body",
      correlationId: "correlation-b",
      deliveryId: "delivery-a",
      requestKey: "request-a",
      presentation: "app",
      identity: scopedIdentity,
    });
    expect(constructed).toHaveLength(2);

    await show({
      category: "notificationIntent",
      title: "Delivery copy",
      body: "Delivery body",
      deliveryId: "delivery-c",
      requestKey: "request-c",
    });
    await show({
      category: "notificationIntent",
      title: "Changed delivery copy",
      body: "Changed delivery body",
      deliveryId: "delivery-c",
      requestKey: "request-d",
    });
    await show({
      category: "notificationIntent",
      title: "Request copy",
      body: "Request body",
      requestKey: "request-e",
    });
    await show({
      category: "notificationIntent",
      title: "Changed request copy",
      body: "Changed request body",
      requestKey: "request-e",
    });

    expect(constructed).toHaveLength(4);
  });

  test("does not suppress identical notifications from distinct assistants", async () => {
    const common = {
      category: "notificationIntent",
      title: "Same title",
      body: "Same body",
      correlationId: "shared-correlation",
      presentation: "app",
    } as const;
    await show({
      ...common,
      identity: {
        scopeId: OPAQUE_SCOPE_A,
        assistantId: "assistant-a",
        nativeSenderId: "native-a",
      },
    });
    await show({
      ...common,
      identity: {
        scopeId: OPAQUE_SCOPE_A,
        assistantId: "assistant-b",
        nativeSenderId: "native-b",
      },
    });

    expect(constructed).toHaveLength(2);
  });

  test("a malformed identity cannot suppress a true legacy notification", async () => {
    const common = {
      category: "notificationIntent",
      title: "Same title",
      body: "Same body",
      correlationId: "legacy-correlation",
    } as const;
    await show({
      ...common,
      identity: {
        scopeId: "account-user-123",
        assistantId: "assistant-a",
        nativeSenderId: "native-a",
      },
    });
    await show(common);

    expect(constructed).toHaveLength(2);
  });

  test("malformed identities skip cooldown instead of colliding", async () => {
    const common = {
      category: "notificationIntent",
      title: "Same title",
      body: "Same body",
      correlationId: "malformed-correlation",
    } as const;
    await show({
      ...common,
      identity: {
        scopeId: "raw-scope-a",
        assistantId: "assistant-a",
        nativeSenderId: "native-a",
      },
    });
    await show({
      ...common,
      identity: {
        scopeId: "raw-scope-b",
        assistantId: "assistant-b",
        nativeSenderId: "native-b",
      },
    });

    expect(constructed).toHaveLength(2);
  });
});

// --- Delivery outcome (the ack the renderer forwards to the daemon) --------

describe("delivery outcome", () => {
  test("returns unsupported without constructing when Notifications are unsupported", async () => {
    notificationSupported = false;
    const result = await show({
      category: "notificationIntent",
      title: "T",
      body: "B",
    });
    expect(result).toEqual({
      success: false,
      errorMessage: "Notifications not supported",
    });
    expect(constructed).toHaveLength(0);
  });

  test("resolves success when the show event fires", async () => {
    deliveryOutcome = "show";
    const result = await show({
      category: "notificationIntent",
      title: "T",
      body: "B",
      deliveryId: "ok-1",
    });
    expect(result.success).toBe(true);
  });

  test("resolves the real failure (no longer optimistic) when delivery fails", async () => {
    deliveryOutcome = "failed";
    const result = await show({
      category: "notificationIntent",
      title: "T",
      body: "B",
      deliveryId: "fail-1",
    });
    // Previously this returned { success: true } before the async failure;
    // the ack now reflects what actually happened, with the OS error text.
    expect(result.success).toBe(false);
    expect(result.errorMessage).toBe("UNErrorDomain error 1");
  });

  test("a failed delivery does not latch off later notifications", async () => {
    deliveryOutcome = "failed";
    const first = await show({
      category: "activityComplete",
      title: "T",
      body: "B",
      deliveryId: "a",
    });
    expect(first.success).toBe(false);
    expect(constructed).toHaveLength(1);

    // No durable denied latch: the next notification still posts and reports
    // its own outcome (matches the Swift client's per-post model).
    deliveryOutcome = "show";
    const second = await show({
      category: "toolConfirmation",
      title: "T2",
      body: "B2",
      deliveryId: "b",
    });
    expect(second.success).toBe(true);
    expect(constructed).toHaveLength(2);
  });

  test("resolves a conservative failure when neither show nor failed fires", async () => {
    __setDeliveryTimeoutForTesting(5);
    deliveryOutcome = "none";
    const result = await show({
      category: "notificationIntent",
      title: "T",
      body: "B",
      deliveryId: "timeout-1",
    });
    expect(result).toEqual({
      success: false,
      errorMessage: "Notification delivery not confirmed",
    });
  });
});

// --- Action / click broadcast ---------------------------------------------

describe("interaction broadcast", () => {
  const richPayload = {
    category: "toolConfirmation",
    title: "Run tool?",
    body: "calculator",
    deliveryId: "del-9",
    conversationId: "conv-9",
    toolCallId: "tc-9",
    deepLinkMetadata: { foo: "bar" },
  };

  test("body click brings the window forward and broadcasts a click event with metadata", async () => {
    await show(richPayload);
    constructed[0]!.emit("click");

    expect(ensureVisibleMock).toHaveBeenCalledTimes(1);
    const actions = sentMessages.filter((m) => m.channel === ACTION_CHANNEL);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.payload).toEqual({
      kind: "click",
      category: "toolConfirmation",
      deliveryId: "del-9",
      conversationId: "conv-9",
      toolCallId: "tc-9",
      deepLinkMetadata: { foo: "bar" },
    });
  });

  test("an action-button press broadcasts the index and resolved button text", async () => {
    await show(richPayload);
    constructed[0]!.emit("action", {}, 1); // "Deny"

    expect(ensureVisibleMock).toHaveBeenCalledTimes(1);
    const actions = sentMessages.filter((m) => m.channel === ACTION_CHANNEL);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.payload).toMatchObject({
      kind: "action",
      category: "toolConfirmation",
      actionIndex: 1,
      actionText: "Deny",
      deliveryId: "del-9",
    });
  });

  test("a click retains its scoped assistant identity", async () => {
    const identity = {
      scopeId: OPAQUE_SCOPE_A,
      assistantId: "assistant-a",
      nativeSenderId: "native-a",
    };
    await show({
      ...richPayload,
      deliveryId: "identity-click",
      presentation: "assistant",
      identity,
    });
    constructed[0]!.emit("click");

    const actions = sentMessages.filter((message) =>
      message.channel === ACTION_CHANNEL,
    );
    expect(actions[0]!.payload).toMatchObject({ identity });
  });
});

// --- Sender (assistant name + notification avatar) -------------------------

describe("sender", () => {
  const AVATAR_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  const AVATAR_HASH = new Bun.CryptoHasher("sha256")
    .update(AVATAR_PNG)
    .digest("hex");
  const sender = {
    id: "assistant-1",
    name: "Aria",
    avatarBase64: AVATAR_PNG.toString("base64"),
    avatarHash: AVATAR_HASH,
  };
  const identity = {
    scopeId: OPAQUE_SCOPE_A,
    assistantId: "assistant-a",
    nativeSenderId: sender.id,
  };
  const assistantPresentation = {
    presentation: "assistant",
    identity,
    nameProvenance: "event",
  } as const;

  const realPlatform = process.platform;
  const setPlatform = (value: string): void => {
    Object.defineProperty(process, "platform", {
      value,
      configurable: true,
    });
  };

  afterEach(() => {
    setPlatform(realPlatform);
  });

  test("checks a captured sender against the current prepared identity", () => {
    prepareIdentity({
      identity,
      scopeEpoch: 1,
      identityRevision: 1,
      name: sender.name,
      nameProvenance: "identity-store",
      avatar: {
        avatarBase64: sender.avatarBase64,
        avatarHash: sender.avatarHash,
      },
    });

    expect(isPreparedNotificationSenderCurrent(identity, sender)).toBe(true);

    resetIdentities({ scopeId: identity.scopeId, scopeEpoch: 2 });
    expect(isPreparedNotificationSenderCurrent(identity, sender)).toBe(false);
  });

  test("the captured schema accepts a sender and drops a partial one", () => {
    expect(
      parseShowPayload({
        category: "notificationIntent",
        title: "t",
        body: "b",
        sender,
      }).sender,
    ).toEqual(sender);
    // The banner is worth more than its decoration, and `handle()` rejects the
    // renderer's call on a parse failure, so a malformed sender is dropped and
    // the notification posts with the app icon.
    expect(
      parseShowPayload({
        category: "notificationIntent",
        title: "t",
        body: "b",
        sender: { id: "assistant-1", name: "Aria" },
      }),
    ).toEqual({
      category: "notificationIntent",
      title: "t",
      body: "b",
      sender: undefined,
      senderDropped: true,
    });
  });

  test("says nothing was dropped when the payload carried no sender", () => {
    expect(
      parseShowPayload({
        category: "notificationIntent",
        title: "t",
        body: "b",
      }).senderDropped,
    ).toBe(false);
  });

  test("warns when the boundary drops a sender the renderer sent", async () => {
    const warnings: string[] = [];
    configureNotifications({
      ipc,
      ensureVisible: ensureVisibleMock,
      logger: {
        warn: (...args: unknown[]) => {
          warnings.push(String(args[0]));
        },
      },
    });

    await showParsed({
      category: "notificationIntent",
      title: "T",
      body: "B",
      deliveryId: "dropped-1",
      sender: { id: "assistant-1", name: "Aria" },
    });
    await showParsed({
      category: "notificationIntent",
      title: "T",
      body: "B",
      deliveryId: "dropped-2",
    });

    expect(warnings).toEqual([
      "[notifications] Dropped malformed inline sender decoration",
    ]);
  });

  test("the captured schema drops a hash that is not a SHA-256", () => {
    // The hash names the avatar's cache file, so a value that is not 64
    // lowercase hex characters must never reach the file the host writes.
    for (const avatarHash of [
      "sha256-abc",
      "../escape",
      AVATAR_HASH.toUpperCase(),
    ]) {
      expect(
        parseShowPayload({
          category: "notificationIntent",
          title: "t",
          body: "b",
          sender: { ...sender, avatarHash },
        }).sender,
      ).toBeUndefined();
    }
  });

  test("hands the factory the decoded avatar bytes", async () => {
    const created: NotificationCreateOptions[] = [];
    configureNotifications({
      ipc,
      ensureVisible: ensureVisibleMock,
      logger: quietLogger,
      create: (options) => {
        created.push(options);
        return new MockNotification(options) as unknown as NotificationLike;
      },
    });

    await show({
      category: "notificationIntent",
      title: "T",
      body: "B",
      deliveryId: "sender-1",
      ...assistantPresentation,
      sender,
    });

    expect(created).toHaveLength(1);
    expect(created[0]!.sender).toEqual({
      id: "assistant-1",
      name: "Aria",
      avatarPng: AVATAR_PNG,
      avatarHash: AVATAR_HASH,
    });
  });

  test("degrades inline sender decoration with a raw scope to plain", async () => {
    const created: NotificationCreateOptions[] = [];
    configureNotifications({
      ipc,
      ensureVisible: ensureVisibleMock,
      logger: quietLogger,
      create: (options) => {
        created.push(options);
        return new MockNotification(options) as unknown as NotificationLike;
      },
    });

    await show({
      category: "notificationIntent",
      title: "Weekly plan",
      body: "Ready",
      deliveryId: "raw-scope-1",
      presentation: "assistant",
      identity: { ...identity, scopeId: "account-user-123" },
      nameProvenance: "event",
      sender,
    });

    expect(created[0]!.sender).toBeUndefined();
    expect(created[0]!.title).toBe("Weekly plan");
    expect(created[0]!.body).toBe("Ready");
  });

  test("rejects a wrong inline hash and uses only an exact prepared fallback", async () => {
    const created: NotificationCreateOptions[] = [];
    const warnings: string[] = [];
    configureNotifications({
      ipc,
      ensureVisible: ensureVisibleMock,
      logger: {
        warn: (...args: unknown[]) => warnings.push(String(args[0])),
      },
      create: (options) => {
        created.push(options);
        return new MockNotification(options) as unknown as NotificationLike;
      },
    });
    prepareIdentity({
      identity,
      scopeEpoch: 1,
      identityRevision: 1,
      avatar: sender,
    });
    const wrongHashSender = {
      ...sender,
      name: "Bob",
      avatarHash: "f".repeat(64),
    };

    await show({
      category: "notificationIntent",
      title: "Prepared fallback",
      body: "Ready",
      deliveryId: "wrong-hash-prepared-1",
      ...assistantPresentation,
      sender: wrongHashSender,
    });

    expect(created[0]!.sender).toEqual({
      id: sender.id,
      name: "Bob",
      avatarPng: AVATAR_PNG,
      avatarHash: AVATAR_HASH,
    });

    resetIdentities({ scopeId: identity.scopeId, scopeEpoch: 2 });
    await show({
      category: "notificationIntent",
      title: "Plain fallback",
      body: "Still ready",
      deliveryId: "wrong-hash-plain-1",
      ...assistantPresentation,
      sender: wrongHashSender,
    });

    expect(created[1]!.sender).toBeUndefined();
    expect(created[1]!.title).toBe("Plain fallback");
    expect(created[1]!.body).toBe("Still ready");
    expect(warnings).toEqual([
      "[notifications] Dropped inline avatar whose hash did not match its bytes",
      "[notifications] Dropped inline avatar whose hash did not match its bytes",
    ]);
  });

  test("uses an exact prepared identity when show carries no avatar bytes", async () => {
    const created: NotificationCreateOptions[] = [];
    configureNotifications({
      ipc,
      ensureVisible: ensureVisibleMock,
      logger: quietLogger,
      create: (options) => {
        created.push(options);
        return new MockNotification(options) as unknown as NotificationLike;
      },
    });
    prepareIdentity({
      identity,
      scopeEpoch: 1,
      identityRevision: 1,
      name: "Alice",
      nameProvenance: "identity-store",
    });
    prepareIdentity({
      identity,
      scopeEpoch: 1,
      identityRevision: 2,
      avatar: sender,
    });

    await show({
      category: "notificationIntent",
      title: "Weekly plan",
      body: "Ready",
      deliveryId: "prepared-1",
      presentation: "assistant",
      identity,
    });

    expect(created[0]!.sender).toEqual({
      id: sender.id,
      name: "Alice",
      avatarPng: AVATAR_PNG,
      avatarHash: AVATAR_HASH,
    });
  });

  test("an event name takes precedence over prepared memory", async () => {
    const created: NotificationCreateOptions[] = [];
    configureNotifications({
      ipc,
      ensureVisible: ensureVisibleMock,
      logger: quietLogger,
      create: (options) => {
        created.push(options);
        return new MockNotification(options) as unknown as NotificationLike;
      },
    });
    prepareIdentity({
      identity,
      scopeEpoch: 1,
      identityRevision: 1,
      name: "Alice",
      nameProvenance: "identity-store",
      avatar: sender,
    });

    await show({
      category: "notificationIntent",
      title: "Weekly plan",
      body: "Ready",
      deliveryId: "event-name-1",
      ...assistantPresentation,
      sender: { ...sender, name: "Bob" },
    });

    expect(created[0]!.sender?.name).toBe("Bob");
  });

  test("an exact prepared store name precedes renderer memory", async () => {
    const created: NotificationCreateOptions[] = [];
    configureNotifications({
      ipc,
      ensureVisible: ensureVisibleMock,
      logger: quietLogger,
      create: (options) => {
        created.push(options);
        return new MockNotification(options) as unknown as NotificationLike;
      },
    });
    prepareIdentity({
      identity,
      scopeEpoch: 1,
      identityRevision: 2,
      name: "Alice",
      nameProvenance: "identity-store",
      avatar: sender,
    });

    await show({
      category: "notificationIntent",
      title: "Weekly plan",
      body: "Ready",
      deliveryId: "store-name-1",
      presentation: "assistant",
      identity,
      nameProvenance: "verified-memory",
      sender: { ...sender, name: "Older name" },
    });

    expect(created[0]!.sender?.name).toBe("Alice");
  });

  test("uses title only for display and omits the duplicate group title", async () => {
    const created: NotificationCreateOptions[] = [];
    configureNotifications({
      ipc,
      ensureVisible: ensureVisibleMock,
      logger: quietLogger,
      create: (options) => {
        created.push(options);
        return new MockNotification(options) as unknown as NotificationLike;
      },
    });
    prepareIdentity({
      identity,
      scopeEpoch: 1,
      identityRevision: 1,
      avatar: sender,
    });

    for (const [index, title] of ["First title", "Second title"].entries()) {
      await show({
        category: "notificationIntent",
        title,
        body: "Ready",
        deliveryId: `title-fallback-${index}`,
        presentation: "assistant",
        identity,
        nameProvenance: "title",
        suppressGroupTitle: true,
      });
    }

    expect(created.map((options) => options.sender?.name)).toEqual([
      "First title",
      "Second title",
    ]);
    expect(created.every((options) => options.suppressGroupTitle)).toBe(true);
  });

  test("app presentation ignores warm assistant identity memory", async () => {
    const created: NotificationCreateOptions[] = [];
    configureNotifications({
      ipc,
      ensureVisible: ensureVisibleMock,
      logger: quietLogger,
      create: (options) => {
        created.push(options);
        return new MockNotification(options) as unknown as NotificationLike;
      },
    });
    prepareIdentity({
      identity,
      scopeEpoch: 1,
      identityRevision: 1,
      name: "Alice",
      nameProvenance: "identity-store",
      avatar: sender,
    });

    await show({
      category: "notificationIntent",
      title: "Weekly plan",
      body: "Ready",
      deliveryId: "app-presentation-1",
      presentation: "app",
      identity,
    });

    expect(created[0]!.sender).toBeUndefined();
  });

  test("scope reset rejects delayed preparation and removes its sender", async () => {
    const created: NotificationCreateOptions[] = [];
    configureNotifications({
      ipc,
      ensureVisible: ensureVisibleMock,
      logger: quietLogger,
      create: (options) => {
        created.push(options);
        return new MockNotification(options) as unknown as NotificationLike;
      },
    });
    prepareIdentity({
      identity,
      scopeEpoch: 1,
      identityRevision: 1,
      name: "Alice",
      nameProvenance: "identity-store",
      avatar: sender,
    });
    resetIdentities({ scopeId: identity.scopeId, scopeEpoch: 2 });
    prepareIdentity({
      identity,
      scopeEpoch: 1,
      identityRevision: 2,
      name: "Stale name",
      nameProvenance: "identity-store",
      avatar: sender,
    });

    await show({
      category: "notificationIntent",
      title: "Weekly plan",
      body: "Ready",
      deliveryId: "reset-1",
      presentation: "assistant",
      identity,
    });

    expect(created[0]!.sender).toBeUndefined();
  });

  test("does not use an identity prepared for another scope", async () => {
    const created: NotificationCreateOptions[] = [];
    configureNotifications({
      ipc,
      ensureVisible: ensureVisibleMock,
      logger: quietLogger,
      create: (options) => {
        created.push(options);
        return new MockNotification(options) as unknown as NotificationLike;
      },
    });
    prepareIdentity({
      identity,
      scopeEpoch: 1,
      identityRevision: 1,
      name: "Alice",
      nameProvenance: "identity-store",
      avatar: sender,
    });

    await show({
      category: "notificationIntent",
      title: "Weekly plan",
      body: "Ready",
      deliveryId: "foreign-scope-1",
      presentation: "assistant",
      identity: { ...identity, scopeId: OPAQUE_SCOPE_B },
    });

    expect(created[0]!.sender).toBeUndefined();
  });

  test("omits the sender from the factory options when the payload carries none", async () => {
    const created: NotificationCreateOptions[] = [];
    configureNotifications({
      ipc,
      ensureVisible: ensureVisibleMock,
      logger: quietLogger,
      create: (options) => {
        created.push(options);
        return new MockNotification(options) as unknown as NotificationLike;
      },
    });

    await show({
      category: "notificationIntent",
      title: "T",
      body: "B",
      deliveryId: "sender-2",
    });

    expect(created[0]!.sender).toBeUndefined();
  });

  test("the default factory gives Linux the avatar as the notification icon", async () => {
    setPlatform("linux");

    await show({
      category: "notificationIntent",
      title: "T",
      body: "B",
      deliveryId: "linux-1",
      ...assistantPresentation,
      sender,
    });

    expect(createFromBufferMock).toHaveBeenCalledTimes(1);
    expect(createFromBufferMock.mock.calls[0]![0]).toEqual(AVATAR_PNG);
    expect(constructed[0]!.options.icon).toEqual({
      nativeImageOf: AVATAR_PNG,
    });
  });

  test("keeps a configured Linux delivery owner for ack and action handling", async () => {
    setPlatform("linux");
    const customFactory = mock(
      (options: NotificationCreateOptions) =>
        new MockNotification(options) as unknown as NotificationLike,
    );
    configureNotifications({
      ipc,
      ensureVisible: ensureVisibleMock,
      logger: quietLogger,
      create: customFactory,
    });

    const result = await show({
      category: "notificationIntent",
      title: "T",
      body: "B",
      deliveryId: "linux-owner-1",
      ...assistantPresentation,
      sender,
    });

    expect(result.success).toBe(true);
    expect(customFactory).toHaveBeenCalledTimes(1);
    expect(customFactory.mock.calls[0]![0].sender?.avatarPng).toEqual(
      AVATAR_PNG,
    );
    expect(createFromBufferMock).not.toHaveBeenCalled();
  });

  test("the default factory leaves macOS without an icon, where it would render as a thumbnail", async () => {
    setPlatform("darwin");

    await show({
      category: "notificationIntent",
      title: "T",
      body: "B",
      deliveryId: "darwin-1",
      ...assistantPresentation,
      sender,
    });

    expect(createFromBufferMock).not.toHaveBeenCalled();
    expect(constructed[0]!.options.icon).toBeUndefined();
    expect(
      (constructed[0]!.options as { sender?: unknown }).sender,
    ).toBeUndefined();
  });
});
