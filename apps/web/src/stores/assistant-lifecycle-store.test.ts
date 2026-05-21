/**
 * Tests for `useAssistantLifecycleStore`. Mock the assistant API and
 * onboarding gate so each action exercises its state-transition guards
 * in isolation.
 */
import { describe, expect, mock, test, beforeEach } from "bun:test";

type GetResult =
  | { ok: true; status: number; data: Record<string, unknown> }
  | { ok: false; status: number; error: Record<string, unknown> };

let getAssistantResult: GetResult = {
  ok: false,
  status: 404,
  error: {},
};
let hatchResult: GetResult = {
  ok: true,
  status: 200,
  data: { id: "fresh-1", status: "initializing" },
};
let retireResult: GetResult = { ok: true, status: 204, data: {} };
let onboardingRedirect: string | null = null;
let isNonProduction = false;

let hatchCalls: Array<Record<string, unknown> | undefined> = [];
let retireCalls: string[] = [];

mock.module("@/assistant/api.js", () => ({
  getAssistant: async () => getAssistantResult,
  hatchAssistant: async (input?: Record<string, unknown>) => {
    hatchCalls.push(input);
    return hatchResult;
  },
  retireAssistantById: async (id: string) => {
    retireCalls.push(id);
    return retireResult;
  },
}));

mock.module("@/domains/onboarding/gate.js", () => ({
  resolveOnboardingRedirect: () => onboardingRedirect,
}));

mock.module("@/lib/environment/environment-store.js", () => ({
  useEnvironmentStore: {
    getState: () => ({ isNonProduction }),
  },
}));

mock.module("@/stores/auth-store.js", () => ({
  useAuthStore: {
    getState: () => ({ isLoggedIn: true, isLoading: false }),
  },
}));

mock.module("@sentry/react", () => ({
  captureException: () => {},
  captureMessage: () => {},
}));

import {
  resetAssistantLifecycleStoreForTests,
  useAssistantLifecycleStore,
} from "@/stores/assistant-lifecycle-store.js";

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  resetAssistantLifecycleStoreForTests();
  hatchCalls = [];
  retireCalls = [];
  getAssistantResult = { ok: false, status: 404, error: {} };
  hatchResult = {
    ok: true,
    status: 200,
    data: { id: "fresh-1", status: "initializing" },
  };
  retireResult = { ok: true, status: 204, data: {} };
  onboardingRedirect = null;
  isNonProduction = false;
});

describe("useAssistantLifecycleStore — initial state", () => {
  test("starts in `loading` with null assistantId", () => {
    const s = useAssistantLifecycleStore.getState();
    expect(s.assistantState.kind).toBe("loading");
    expect(s.assistantId).toBe(null);
    expect(s.autoGreet).toBe(false);
    expect(s.initializingCycle).toBe(0);
  });
});

describe("checkAssistant", () => {
  test("transitions to `active` when daemon reports active", async () => {
    getAssistantResult = {
      ok: true,
      status: 200,
      data: {
        id: "assistant-9",
        status: "active",
        is_local: false,
        maintenance_mode: { enabled: false },
      },
    };
    await useAssistantLifecycleStore.getState().checkAssistant();
    const s = useAssistantLifecycleStore.getState();
    expect(s.assistantState.kind).toBe("active");
    expect(s.assistantId).toBe("assistant-9");
  });

  test("transitions to `self_hosted` when daemon reports active + is_local", async () => {
    getAssistantResult = {
      ok: true,
      status: 200,
      data: {
        id: "assistant-9",
        status: "active",
        is_local: true,
      },
    };
    await useAssistantLifecycleStore.getState().checkAssistant();
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "self_hosted",
    );
  });

  test("transitions to `initializing` while daemon is hatching", async () => {
    getAssistantResult = {
      ok: true,
      status: 200,
      data: { id: "warm-1", status: "initializing" },
    };
    await useAssistantLifecycleStore.getState().checkAssistant();
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "initializing",
    );
  });

  test("404 triggers auto-hatch and arms autoGreet", async () => {
    getAssistantResult = { ok: false, status: 404, error: {} };
    await useAssistantLifecycleStore.getState().checkAssistant();
    expect(hatchCalls.length).toBe(1);
    expect(useAssistantLifecycleStore.getState().autoGreet).toBe(true);
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "initializing",
    );
  });

  test("404 + nonproduction surfaces version-selection screen", async () => {
    isNonProduction = true;
    getAssistantResult = { ok: false, status: 404, error: {} };
    await useAssistantLifecycleStore.getState().checkAssistant();
    expect(hatchCalls.length).toBe(0);
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "awaiting_version_selection",
    );
  });

  test("404 + pending onboarding triggers redirect, not hatch", async () => {
    onboardingRedirect = "/onboarding/privacy";
    getAssistantResult = { ok: false, status: 404, error: {} };
    const redirects: string[] = [];
    useAssistantLifecycleStore.getState().setRedirectHandler((url) => {
      redirects.push(url);
    });
    await useAssistantLifecycleStore.getState().checkAssistant();
    expect(redirects).toEqual(["/onboarding/privacy"]);
    expect(hatchCalls.length).toBe(0);
  });

  test("non-404 error surfaces an `error` state with message", async () => {
    getAssistantResult = {
      ok: false,
      status: 502,
      error: { detail: "Bad gateway" },
    };
    await useAssistantLifecycleStore.getState().checkAssistant();
    const s = useAssistantLifecycleStore.getState().assistantState;
    expect(s.kind).toBe("error");
    if (s.kind === "error") {
      expect(s.message.length).toBeGreaterThan(0);
    }
  });
});

describe("hatchVersion", () => {
  test("arms autoGreet and dispatches a hatch with the version", async () => {
    useAssistantLifecycleStore.getState().hatchVersion("v1.2.3");
    await flushMicrotasks();
    await flushMicrotasks();
    expect(hatchCalls[0]).toEqual({ version: "v1.2.3" });
    expect(useAssistantLifecycleStore.getState().autoGreet).toBe(true);
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "initializing",
    );
  });
});

describe("retryAssistant", () => {
  test("resets retry counters and re-checks the daemon", async () => {
    getAssistantResult = {
      ok: true,
      status: 200,
      data: {
        id: "post-retry",
        status: "active",
        is_local: false,
        maintenance_mode: { enabled: false },
      },
    };
    useAssistantLifecycleStore.getState().retryAssistant();
    await flushMicrotasks();
    await flushMicrotasks();
    expect(useAssistantLifecycleStore.getState().assistantId).toBe(
      "post-retry",
    );
  });
});

describe("setAssistantId / setAutoGreet", () => {
  test("setAssistantId writes through to the store", () => {
    useAssistantLifecycleStore.getState().setAssistantId("abc-123");
    expect(useAssistantLifecycleStore.getState().assistantId).toBe("abc-123");
    useAssistantLifecycleStore.getState().setAssistantId(null);
    expect(useAssistantLifecycleStore.getState().assistantId).toBe(null);
  });

  test("setAutoGreet flips the boolean flag", () => {
    useAssistantLifecycleStore.getState().setAutoGreet(true);
    expect(useAssistantLifecycleStore.getState().autoGreet).toBe(true);
    useAssistantLifecycleStore.getState().setAutoGreet(false);
    expect(useAssistantLifecycleStore.getState().autoGreet).toBe(false);
  });
});

describe("recoverStuckInitializing", () => {
  test("retires the stuck assistant and hatches a replacement", async () => {
    // Seed the store with an initializing assistant id by going through
    // checkAssistant first.
    getAssistantResult = {
      ok: true,
      status: 200,
      data: { id: "stuck-1", status: "initializing" },
    };
    await useAssistantLifecycleStore.getState().checkAssistant();

    retireResult = { ok: true, status: 204, data: {} };
    hatchResult = {
      ok: true,
      status: 200,
      data: { id: "fresh-after-recovery", status: "initializing" },
    };
    await useAssistantLifecycleStore.getState().recoverStuckInitializing();
    expect(retireCalls).toContain("stuck-1");
    expect(hatchCalls.length).toBeGreaterThanOrEqual(1);
    expect(useAssistantLifecycleStore.getState().assistantState.kind).toBe(
      "initializing",
    );
  });

  test("after MAX_INITIALIZING_RECOVERIES, surfaces timeout error", async () => {
    // Hit the cap.
    getAssistantResult = {
      ok: true,
      status: 200,
      data: { id: "stuck-cap", status: "initializing" },
    };
    await useAssistantLifecycleStore.getState().checkAssistant();
    // Three recoveries exhaust the budget; the fourth should bail.
    await useAssistantLifecycleStore.getState().recoverStuckInitializing();
    await useAssistantLifecycleStore.getState().recoverStuckInitializing();
    await useAssistantLifecycleStore.getState().recoverStuckInitializing();
    await useAssistantLifecycleStore.getState().recoverStuckInitializing();
    const s = useAssistantLifecycleStore.getState().assistantState;
    expect(s.kind).toBe("error");
  });
});

describe("setRedirectHandler", () => {
  test("registered handler is invoked from the onboarding-redirect path", async () => {
    const calls: string[] = [];
    useAssistantLifecycleStore
      .getState()
      .setRedirectHandler((url) => calls.push(url));
    onboardingRedirect = "/onboarding/welcome";
    getAssistantResult = { ok: false, status: 404, error: {} };
    await useAssistantLifecycleStore.getState().checkAssistant();
    expect(calls).toEqual(["/onboarding/welcome"]);
  });

  test("clearing the handler prevents further redirects", async () => {
    const calls: string[] = [];
    useAssistantLifecycleStore
      .getState()
      .setRedirectHandler((url) => calls.push(url));
    useAssistantLifecycleStore.getState().setRedirectHandler(null);
    onboardingRedirect = "/onboarding/welcome";
    getAssistantResult = { ok: false, status: 404, error: {} };
    await useAssistantLifecycleStore.getState().checkAssistant();
    expect(calls).toEqual([]);
  });
});

describe("platform-hosted disabled (capacity kill-switch)", () => {
  test("503 + platform_hosted_disabled surfaces the tailored message", async () => {
    getAssistantResult = { ok: false, status: 404, error: {} };
    hatchResult = {
      ok: false,
      status: 503,
      error: { code: "platform_hosted_disabled" },
    };
    await useAssistantLifecycleStore.getState().checkAssistant();
    const s = useAssistantLifecycleStore.getState().assistantState;
    expect(s.kind).toBe("error");
    if (s.kind === "error") {
      expect(s.message).toMatch(/capacity/i);
    }
  });
});
