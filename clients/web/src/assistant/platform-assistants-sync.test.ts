import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";

import type { PlatformSessionStatus } from "@/stores/session-status";

// Mode predicates that select whether the load runs.
let mockIsLocalClient = false;
let mockIsRemoteGatewayMode = false;
let mockIsGatewayAuthEnabled = false;

mock.module("@/lib/local-mode", () => ({
  isLocalClient: () => mockIsLocalClient,
  isRemoteGatewayMode: () => mockIsRemoteGatewayMode,
}));

mock.module("@/lib/auth/gateway-session", () => ({
  isGatewayAuthEnabled: () => mockIsGatewayAuthEnabled,
}));

// The platform assistants fetch. Default to a well-formed empty ok result;
// tests override to exercise the ok / not-ok / thrown branches. When
// `listAssistantsGates` is set, each call parks until its resolver (pushed here
// in call order) is invoked, so a test can hold reloads in flight and settle
// them in a chosen order.
let mockListAssistantsResult: unknown = { ok: true, status: 200, data: [] };
let mockListAssistantsError: Error | null = null;
let listAssistantsGates: Array<(result: unknown) => void> | null = null;
const listAssistantsMock = mock(async () => {
  if (mockListAssistantsError) {
    throw mockListAssistantsError;
  }
  if (listAssistantsGates) {
    return await new Promise<unknown>((resolve) => {
      listAssistantsGates!.push(resolve);
    });
  }
  return mockListAssistantsResult;
});
mock.module("@/assistant/api", () => ({
  listAssistants: listAssistantsMock,
}));

const fetchOrganizationsMock = mock(async () => {});
mock.module("@/stores/organization-store", () => ({
  useOrganizationStore: {
    getState: () => ({ fetchOrganizations: fetchOrganizationsMock }),
  },
}));

const setFromApiMock = mock((_assistants: unknown) => {});
const markHydratedMock = mock(() => {});
mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    getState: () => ({
      setFromApi: setFromApiMock,
      markHydrated: markHydratedMock,
    }),
  },
}));

const captureErrorMock = mock((_error: unknown, _opts: unknown) => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

// Event bus: capture the `app.resume` subscriber so tests can fire resume
// signals, and count unsubscribes.
type ResumeHandler = (payload: { signal: string }) => void;
let resumeHandler: ResumeHandler | null = null;
const resumeUnsubscribeMock = mock(() => {});
mock.module("@/lib/event-bus", () => ({
  subscribe: (topic: string, handler: ResumeHandler) => {
    if (topic === "app.resume") {
      resumeHandler = handler;
    }
    return resumeUnsubscribeMock;
  },
}));

// Auth store: a getState + subscribe seam the sync module wires onto. Tests
// drive transitions by invoking the captured subscriber with (next, prev) and
// mutate `authState` directly to simulate logout / account-switch mid-load.
type AuthUser = { id: string } | null;
type AuthSnapshot = {
  platformSession: PlatformSessionStatus;
  user: AuthUser;
};
let authState: AuthSnapshot = { platformSession: "unknown", user: null };
type AuthSubscriber = (state: AuthSnapshot, prevState: AuthSnapshot) => void;
let subscriber: AuthSubscriber | null = null;
mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => authState,
    subscribe: (listener: AuthSubscriber) => {
      subscriber = listener;
      return () => {
        subscriber = null;
      };
    },
  },
}));

const {
  refreshPlatformAssistantsIfStale,
  reloadPlatformAssistants,
  setupPlatformAssistantsSync,
} = await import("@/assistant/platform-assistants-sync");

/** Move the mocked auth store to `next` (keeping the user) and notify. */
function transition(next: PlatformSessionStatus): void {
  const prevState = authState;
  authState = { platformSession: next, user: prevState.user };
  subscriber?.(authState, prevState);
}

const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

// Frozen mock clock for the stale-refresh window. Each test starts a minute
// past the previous one so any earlier stamp is already stale.
const STALE_TIME_MS = 10_000;
let now = new Date("2026-01-01T00:00:00Z").getTime();
function advance(ms: number): void {
  now += ms;
  setSystemTime(new Date(now));
}

afterAll(() => {
  setSystemTime();
});

beforeEach(() => {
  advance(60_000);
  mockIsLocalClient = false;
  mockIsRemoteGatewayMode = false;
  mockIsGatewayAuthEnabled = false;
  mockListAssistantsResult = { ok: true, status: 200, data: [] };
  mockListAssistantsError = null;
  listAssistantsGates = null;
  authState = { platformSession: "unknown", user: null };
  subscriber = null;
  resumeHandler = null;
  resumeUnsubscribeMock.mockClear();
  listAssistantsMock.mockClear();
  fetchOrganizationsMock.mockClear();
  setFromApiMock.mockClear();
  markHydratedMock.mockClear();
  captureErrorMock.mockClear();
});

describe("setupPlatformAssistantsSync", () => {
  test("reloads on an unknown → present transition", async () => {
    setupPlatformAssistantsSync();

    transition("present");
    await tick();

    expect(listAssistantsMock).toHaveBeenCalledTimes(1);
  });

  test("reloads on an absent → present transition", async () => {
    setupPlatformAssistantsSync();

    transition("absent");
    await tick();
    expect(listAssistantsMock).not.toHaveBeenCalled();

    transition("present");
    await tick();
    expect(listAssistantsMock).toHaveBeenCalledTimes(1);
  });

  test("does not reload on present → present or present → absent", async () => {
    setupPlatformAssistantsSync();

    transition("present");
    await tick();
    expect(listAssistantsMock).toHaveBeenCalledTimes(1);

    transition("present");
    transition("absent");
    await tick();

    expect(listAssistantsMock).toHaveBeenCalledTimes(1);
  });

  test("does not reload on transitions that never reach present", async () => {
    setupPlatformAssistantsSync();

    transition("absent");
    transition("unknown");
    await tick();

    expect(listAssistantsMock).not.toHaveBeenCalled();
  });

  test("unsubscribing stops further reloads and drops the resume listener", async () => {
    const cleanup = setupPlatformAssistantsSync();
    cleanup();

    transition("present");
    await tick();

    expect(listAssistantsMock).not.toHaveBeenCalled();
    expect(resumeUnsubscribeMock).toHaveBeenCalledTimes(1);
  });

  test("app.resume reloads when the list is stale and a session is present", async () => {
    authState = { platformSession: "present", user: { id: "u1" } };
    setupPlatformAssistantsSync();

    resumeHandler?.({ signal: "visibility" });
    await tick();

    expect(listAssistantsMock).toHaveBeenCalledTimes(1);
  });

  test("app.resume does not reload within the stale window", async () => {
    authState = { platformSession: "present", user: { id: "u1" } };
    setupPlatformAssistantsSync();

    resumeHandler?.({ signal: "visibility" });
    await tick();
    expect(listAssistantsMock).toHaveBeenCalledTimes(1);

    advance(STALE_TIME_MS / 2);
    resumeHandler?.({ signal: "visibility" });
    await tick();
    expect(listAssistantsMock).toHaveBeenCalledTimes(1);

    advance(STALE_TIME_MS);
    resumeHandler?.({ signal: "visibility" });
    await tick();
    expect(listAssistantsMock).toHaveBeenCalledTimes(2);
  });

  test("app.resume does not reload without a live platform session", async () => {
    authState = { platformSession: "absent", user: null };
    setupPlatformAssistantsSync();

    resumeHandler?.({ signal: "visibility" });
    await tick();

    expect(listAssistantsMock).not.toHaveBeenCalled();
  });
});

describe("refreshPlatformAssistantsIfStale", () => {
  test("respects the stale window across consecutive calls", async () => {
    authState = { platformSession: "present", user: { id: "u1" } };

    await refreshPlatformAssistantsIfStale();
    expect(listAssistantsMock).toHaveBeenCalledTimes(1);

    await refreshPlatformAssistantsIfStale();
    expect(listAssistantsMock).toHaveBeenCalledTimes(1);

    advance(STALE_TIME_MS + 1);
    await refreshPlatformAssistantsIfStale();
    expect(listAssistantsMock).toHaveBeenCalledTimes(2);
  });

  test("no-ops when the platform session is not present", async () => {
    authState = { platformSession: "unknown", user: null };

    await refreshPlatformAssistantsIfStale();

    expect(listAssistantsMock).not.toHaveBeenCalled();
  });

  test("coalesces onto an in-flight reload instead of starting a duplicate", async () => {
    const gates: Array<(result: unknown) => void> = [];
    listAssistantsGates = gates;
    authState = { platformSession: "present", user: { id: "u1" } };

    const reload = reloadPlatformAssistants();
    await tick();
    expect(gates.length).toBe(1);

    const refresh = refreshPlatformAssistantsIfStale();
    await tick();
    expect(listAssistantsMock).toHaveBeenCalledTimes(1);

    const data = [{ id: "a1" }];
    gates[0]!({ ok: true, status: 200, data });
    await Promise.all([reload, refresh]);

    // The lone reload's write lands; nothing superseded it.
    expect(setFromApiMock).toHaveBeenCalledTimes(1);
    expect(setFromApiMock).toHaveBeenCalledWith(data);

    // The refresh path fetches again once the settled load goes stale.
    advance(STALE_TIME_MS + 1);
    listAssistantsGates = null;
    await refreshPlatformAssistantsIfStale();
    expect(listAssistantsMock).toHaveBeenCalledTimes(2);
  });
});

describe("reloadPlatformAssistants", () => {
  test("early-returns in local mode without touching the resolved store", async () => {
    mockIsLocalClient = true;

    await reloadPlatformAssistants();

    expect(fetchOrganizationsMock).not.toHaveBeenCalled();
    expect(listAssistantsMock).not.toHaveBeenCalled();
    expect(setFromApiMock).not.toHaveBeenCalled();
    expect(markHydratedMock).not.toHaveBeenCalled();
  });

  test("early-returns in remote-gateway mode", async () => {
    mockIsRemoteGatewayMode = true;

    await reloadPlatformAssistants();

    expect(listAssistantsMock).not.toHaveBeenCalled();
    expect(setFromApiMock).not.toHaveBeenCalled();
    expect(markHydratedMock).not.toHaveBeenCalled();
  });

  test("early-returns when gateway auth is enabled", async () => {
    mockIsGatewayAuthEnabled = true;

    await reloadPlatformAssistants();

    expect(listAssistantsMock).not.toHaveBeenCalled();
    expect(setFromApiMock).not.toHaveBeenCalled();
    expect(markHydratedMock).not.toHaveBeenCalled();
  });

  test("populates the resolved store from a successful listAssistants", async () => {
    const data = [
      {
        id: "a1",
        name: "One",
        is_local: false,
        created: "2026-01-01T00:00:00Z",
      },
    ];
    mockListAssistantsResult = { ok: true, status: 200, data };
    authState = { platformSession: "present", user: { id: "u1" } };

    await reloadPlatformAssistants();

    expect(fetchOrganizationsMock).toHaveBeenCalledTimes(1);
    expect(setFromApiMock).toHaveBeenCalledWith(data);
    expect(markHydratedMock).not.toHaveBeenCalled();
  });

  test("marks the list hydrated when listAssistants returns a failure", async () => {
    mockListAssistantsResult = { ok: false, status: 500, error: {} };
    authState = { platformSession: "present", user: { id: "u1" } };

    await reloadPlatformAssistants();

    expect(markHydratedMock).toHaveBeenCalledTimes(1);
    expect(setFromApiMock).not.toHaveBeenCalled();
  });

  test("marks the list hydrated and reports when the fetch throws", async () => {
    mockListAssistantsError = new Error("network down");
    authState = { platformSession: "present", user: { id: "u1" } };

    await reloadPlatformAssistants();

    expect(markHydratedMock).toHaveBeenCalledTimes(1);
    expect(setFromApiMock).not.toHaveBeenCalled();
    expect(captureErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ context: "reloadPlatformAssistants" }),
    );
  });

  test("does not write when the platform session flips away from present mid-load", async () => {
    const gates: Array<(result: unknown) => void> = [];
    listAssistantsGates = gates;
    authState = { platformSession: "present", user: { id: "u1" } };

    const pending = reloadPlatformAssistants();
    await tick();
    expect(gates.length).toBe(1);

    // The user logs out while the fetch is in flight.
    authState = { platformSession: "absent", user: null };
    gates[0]!({ ok: true, status: 200, data: [{ id: "a1" }] });
    await pending;

    expect(setFromApiMock).not.toHaveBeenCalled();
    expect(markHydratedMock).not.toHaveBeenCalled();
  });

  test("does not write when the platform user changes mid-load", async () => {
    const gates: Array<(result: unknown) => void> = [];
    listAssistantsGates = gates;
    authState = { platformSession: "present", user: { id: "u1" } };

    const pending = reloadPlatformAssistants();
    await tick();
    expect(gates.length).toBe(1);

    // A different account is now signed in.
    authState = { platformSession: "present", user: { id: "u2" } };
    gates[0]!({ ok: true, status: 200, data: [{ id: "a1" }] });
    await pending;

    expect(setFromApiMock).not.toHaveBeenCalled();
    expect(markHydratedMock).not.toHaveBeenCalled();
  });

  test("latest-wins: a superseded reload does not write, the newest does", async () => {
    const gates: Array<(result: unknown) => void> = [];
    listAssistantsGates = gates;
    authState = { platformSession: "present", user: { id: "u1" } };

    const first = reloadPlatformAssistants();
    await tick();
    const second = reloadPlatformAssistants();
    await tick();
    expect(gates.length).toBe(2);

    const staleData = [{ id: "stale" }];
    const freshData = [{ id: "fresh" }];

    // Settle the older (superseded) reload first — it must not write.
    gates[0]!({ ok: true, status: 200, data: staleData });
    await first;
    expect(setFromApiMock).not.toHaveBeenCalled();

    // The newest reload writes.
    gates[1]!({ ok: true, status: 200, data: freshData });
    await second;
    expect(setFromApiMock).toHaveBeenCalledTimes(1);
    expect(setFromApiMock).toHaveBeenCalledWith(freshData);
  });
});
