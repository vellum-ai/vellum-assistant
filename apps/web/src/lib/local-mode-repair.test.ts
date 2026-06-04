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
}));

mock.module("@/lib/auth/gateway-session", () => ({
  clearGatewayToken: () => {},
  ensureGatewayToken: async () => {},
  getGatewayToken: () => "gateway-tok",
  getLocalTokenUrl: () => "http://127.0.0.1:7830/token",
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
});
