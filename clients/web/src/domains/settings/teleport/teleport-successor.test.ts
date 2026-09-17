import { beforeEach, describe, expect, mock, test } from "bun:test";

import { PlatformIdentityInjectionError } from "@/lib/platform-identity-errors";

const PLATFORM_ID = "11111111-1111-4111-8111-111111111111";

let resolveOutcome: () => Promise<string> = async () => PLATFORM_ID;
const resolveLocalAssistantPlatformIdentity = mock(
  async (_id: string, _options?: unknown) => resolveOutcome(),
);
mock.module("@/lib/local-platform-identity", () => ({
  resolveLocalAssistantPlatformIdentity,
  isUuid: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    ),
}));

const { resolveTeleportSuccessorId } = await import("./teleport-successor");

beforeEach(() => {
  resolveOutcome = async () => PLATFORM_ID;
  resolveLocalAssistantPlatformIdentity.mockClear();
});

describe("resolveTeleportSuccessorId", () => {
  test("a managed target is its own platform id", async () => {
    // GIVEN a managed teleport target
    // WHEN resolving the successor
    const id = await resolveTeleportSuccessorId({ id: "m1", kind: "managed" });

    // THEN no lookup is needed
    expect(id).toBe("m1");
    expect(resolveLocalAssistantPlatformIdentity).not.toHaveBeenCalled();
  });

  test("a local target resolves through its platform registration", async () => {
    // GIVEN a local target whose bootstrap registers it on the platform
    // WHEN resolving the successor
    const id = await resolveTeleportSuccessorId({ id: "local-1", kind: "local" });

    // THEN the registration's platform id is the successor
    expect(id).toBe(PLATFORM_ID);
    expect(resolveLocalAssistantPlatformIdentity).toHaveBeenCalledWith(
      "local-1",
      { allowGatewayRepair: false },
    );
  });

  test("a registration whose injection failed still names the successor", async () => {
    // GIVEN the platform registered the target but the local credential
    // injection failed afterwards
    resolveOutcome = async () => {
      throw new PlatformIdentityInjectionError(
        PLATFORM_ID,
        new Error("gateway restarting"),
      );
    };

    // WHEN resolving the successor
    const id = await resolveTeleportSuccessorId({ id: "local-1", kind: "local" });

    // THEN the registered id is used: the platform can move the connections
    // to it, and the bootstrap finishes the local side later
    expect(id).toBe(PLATFORM_ID);
  });

  test("an unregistered local target yields null", async () => {
    // GIVEN a target the platform never registered
    resolveOutcome = async () => {
      throw new Error("Sign in to Vellum");
    };

    // WHEN resolving the successor
    const id = await resolveTeleportSuccessorId({ id: "local-1", kind: "local" });

    // THEN the caller retires without a successor
    expect(id).toBeNull();
  });

  test("a non-UUID resolution (platform disabled) yields null", async () => {
    // GIVEN the identity flow echoed the local id back unchanged
    resolveOutcome = async () => "local-1";

    // WHEN resolving the successor
    const id = await resolveTeleportSuccessorId({ id: "local-1", kind: "local" });

    // THEN there is nothing the platform could receive
    expect(id).toBeNull();
  });
});
