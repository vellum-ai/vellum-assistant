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
 * `electron`, `./ipc`, `./main-window`, and `./logger` are all mocked so the
 * module can be imported and driven without an Electron runtime. Each test
 * file runs in its own process (see `scripts/run-tests.ts`), so these
 * per-file `mock.module` overrides don't leak.
 */

// --- Mock: electron (Notification + BrowserWindow) -------------------------

interface MockNotificationOptions {
  title: string;
  body: string;
  silent: boolean;
  actions: Array<{ type: "button"; text: string }>;
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
  private readonly handlers: Record<string, Array<(...args: unknown[]) => void>> =
    {};
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

mock.module("electron", () => ({
  Notification: MockNotification,
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

// --- Mock: ./ipc (capture the registered handler) --------------------------

type HandleRegistration = {
  channel: string;
  schema: z.ZodType<unknown[]>;
  fn: (args: unknown[]) => unknown;
};
const handleRegistrations: HandleRegistration[] = [];
const handleMock = mock(
  (
    channel: string,
    schema: z.ZodType<unknown[]>,
    fn: (args: unknown[]) => unknown,
  ) => {
    handleRegistrations.push({ channel, schema, fn });
  },
);
mock.module("./ipc", () => ({ handle: handleMock }));

// --- Mock: ./main-window (ensureVisible spy) -------------------------------

const ensureVisibleMock = mock(() => Promise.resolve());
mock.module("./main-window", () => ({ ensureVisible: ensureVisibleMock }));

// --- Mock: ./logger --------------------------------------------------------

mock.module("./logger", () => ({
  default: {
    warn: () => undefined,
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  },
}));

const {
  installNotifications,
  NOTIFICATION_CATEGORIES,
  __resetForTesting,
  __setDeliveryTimeoutForTesting,
} = await import("./notifications");

// --- Helpers ---------------------------------------------------------------

const SHOW_CHANNEL = "vellum:notifications:show";
const ACTION_CHANNEL = "vellum:notifications:action";

interface ShowResult {
  success: boolean;
  errorMessage?: string;
}

const showHandler = (): HandleRegistration => {
  const reg = handleRegistrations.find((r) => r.channel === SHOW_CHANNEL);
  if (!reg) throw new Error(`no handler registered for ${SHOW_CHANNEL}`);
  return reg;
};

/** Invoke the registered show handler the way `./ipc` would (tuple arg). */
const show = (payload: Record<string, unknown>): Promise<ShowResult> =>
  showHandler().fn([payload]) as Promise<ShowResult>;

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
  at(0);
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
});
