import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { useLockfileStore } from "@/stores/lockfile-store";
import type { Lockfile, LockfileAssistant } from "@/runtime/local-mode-host";

// The wrapper under test orchestrates the real connect primitive, so we drive
// its external seams rather than the primitive itself: the guardian-token read
// (which decides success/failure) and the wake repair call. Everything else in
// the primitive (gateway token exchange, self-hosted connection write) is
// stubbed to no-op so a successful prime resolves cleanly.
const host = await import("@/runtime/local-mode-host");

let primeShouldSucceed: () => boolean;
let fetchGuardianTokenHost = mock(async (_id: string) => "tok");
let wakeLocalAssistantHost = mock(async (_id: string) => ({ ok: true }));

mock.module("@/runtime/local-mode-host", () => ({
  ...host,
  fetchGuardianTokenHost: (id: string) => fetchGuardianTokenHost(id),
  wakeLocalAssistantHost: (id: string) => wakeLocalAssistantHost(id),
  // The post-wake reload reads back the lockfile; serve the in-store copy so the
  // retry resolves the selected assistant rather than hitting the real host.
  loadLockfileHost: async () =>
    useLockfileStore.getState().lockfile ?? {
      assistants: [],
      activeAssistant: null,
    },
}));

mock.module("@/lib/auth/gateway-session", () => ({
  clearGatewayToken: () => {},
  ensureGatewayToken: async () => {},
  getGatewayToken: () => "gateway-tok",
  // Mirror the real chain (token URL derives from the assistant's gateway port)
  // so a portless entry yields no URL until wake records one.
  getLocalTokenUrl: (a?: LockfileAssistant) => {
    const port = a?.resources?.gatewayPort;
    return port == null ? undefined : `http://127.0.0.1:${port}/token`;
  },
}));

mock.module("@/lib/self-hosted/connection", () => ({
  setSelfHostedConnection: () => {},
}));

const { GuardianTokenError } = host;
const { primeLocalGatewayConnectionWithRepair } = await import("@/lib/local-mode");

const localAssistant: LockfileAssistant = {
  assistantId: "local-a",
  cloud: "local",
  resources: { gatewayPort: 7830 },
} as LockfileAssistant;

function selectLocalAssistant(): void {
  const lockfile: Lockfile = {
    assistants: [localAssistant],
    activeAssistant: "local-a",
  };
  useLockfileStore.setState({ lockfile });
  localStorage.setItem("vellum:local:selected-assistant", "local-a");
}

beforeEach(() => {
  primeShouldSucceed = () => true;
  fetchGuardianTokenHost = mock(async (_id: string) => {
    if (!primeShouldSucceed()) throw new GuardianTokenError(404, "token gone");
    return "tok";
  });
  wakeLocalAssistantHost = mock(async (_id: string) => ({ ok: true }));
  selectLocalAssistant();
});

afterEach(() => {
  useLockfileStore.setState({ lockfile: null });
  localStorage.clear();
  process.env.VITE_PLATFORM_MODE = "true";
});

describe("primeLocalGatewayConnectionWithRepair", () => {
  test("a clean first attempt never wakes the assistant", async () => {
    await primeLocalGatewayConnectionWithRepair();
    expect(wakeLocalAssistantHost).not.toHaveBeenCalled();
  });

  test("a repairable failure wakes once, then retries and succeeds", async () => {
    let attempts = 0;
    // Fail the first prime (missing token), succeed once wake has run.
    primeShouldSucceed = () => attempts++ > 0;

    await primeLocalGatewayConnectionWithRepair();

    expect(wakeLocalAssistantHost).toHaveBeenCalledTimes(1);
    expect(wakeLocalAssistantHost).toHaveBeenCalledWith("local-a");
    // One failing attempt + one succeeding retry.
    expect(fetchGuardianTokenHost).toHaveBeenCalledTimes(2);
  });

  test("a still-failing retry surfaces the original error and wakes only once", async () => {
    primeShouldSucceed = () => false;

    const err = await primeLocalGatewayConnectionWithRepair().catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GuardianTokenError);
    expect(wakeLocalAssistantHost).toHaveBeenCalledTimes(1);
  });

  test("a failed wake surfaces the original error without retrying", async () => {
    primeShouldSucceed = () => false;
    wakeLocalAssistantHost = mock(async () => ({
      ok: false,
      error: "no sibling env",
    }));

    const err = await primeLocalGatewayConnectionWithRepair().catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GuardianTokenError);
    // The first prime failed and wake failed — the connection is never retried.
    expect(fetchGuardianTokenHost).toHaveBeenCalledTimes(1);
  });

  test("a non-repairable 403 surfaces immediately and never wakes", async () => {
    fetchGuardianTokenHost = mock(async () => {
      throw new GuardianTokenError(403, "forbidden");
    });

    const err = await primeLocalGatewayConnectionWithRepair().catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GuardianTokenError);
    expect((err as InstanceType<typeof GuardianTokenError>).status).toBe(403);
    expect(wakeLocalAssistantHost).not.toHaveBeenCalled();
  });

  test("recovers a portless legacy assistant: wakes, reloads the port, then retries", async () => {
    // The Swift→Electron import case: a legacy entry reaches the renderer with
    // no recorded gateway port, so the first prime can't resolve a gateway.
    process.env.VITE_PLATFORM_MODE = "";
    const portless: LockfileAssistant = {
      assistantId: "local-a",
      cloud: "local",
    } as LockfileAssistant;
    useLockfileStore.setState({
      lockfile: { assistants: [portless], activeAssistant: "local-a" },
    });

    // Wake establishes the daemon + gateway and records the port; model that by
    // writing the resolved entry back to the store the post-wake reload reads.
    wakeLocalAssistantHost = mock(async (_id: string) => {
      useLockfileStore.setState({
        lockfile: {
          assistants: [
            {
              ...portless,
              resources: { gatewayPort: 7830, daemonPort: 7831 },
            },
          ],
          activeAssistant: "local-a",
        },
      });
      return { ok: true };
    });

    await primeLocalGatewayConnectionWithRepair();

    expect(wakeLocalAssistantHost).toHaveBeenCalledTimes(1);
    expect(wakeLocalAssistantHost).toHaveBeenCalledWith("local-a");
    // The first attempt fails at gateway resolution, before any token fetch; the
    // guardian token is fetched only on the retry, once the port resolves.
    expect(fetchGuardianTokenHost).toHaveBeenCalledTimes(1);
  });
});
