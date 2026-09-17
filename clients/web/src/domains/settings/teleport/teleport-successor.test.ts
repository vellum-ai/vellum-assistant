import { beforeEach, describe, expect, mock, test } from "bun:test";

let resolved: string | null = null;
const resolvePlatformAssistantId = mock(async (_id: string) => resolved);
mock.module("@/lib/platform-assistant-id", () => ({
  resolvePlatformAssistantId,
}));

const { resolveTeleportSuccessorId } = await import("./teleport-successor");

beforeEach(() => {
  resolved = null;
  resolvePlatformAssistantId.mockClear();
});

describe("resolveTeleportSuccessorId", () => {
  test("a managed target is its own platform id", async () => {
    // GIVEN a managed teleport target
    // WHEN resolving the successor
    const id = await resolveTeleportSuccessorId({ id: "m1", kind: "managed" });

    // THEN no lookup is needed
    expect(id).toBe("m1");
    expect(resolvePlatformAssistantId).not.toHaveBeenCalled();
  });

  test("a local target resolves through its platform registration", async () => {
    // GIVEN a local target whose bootstrap registers it on the platform
    resolved = "11111111-1111-4111-8111-111111111111";

    // WHEN resolving the successor
    const id = await resolveTeleportSuccessorId({ id: "local-1", kind: "local" });

    // THEN the registration's platform id is the successor
    expect(id).toBe(resolved);
    expect(resolvePlatformAssistantId).toHaveBeenCalledWith("local-1");
  });

  test("an unregistered local target yields null", async () => {
    // GIVEN a local target the platform never registered
    // WHEN resolving the successor
    const id = await resolveTeleportSuccessorId({ id: "local-1", kind: "local" });

    // THEN the caller retires without a successor
    expect(id).toBeNull();
  });
});
