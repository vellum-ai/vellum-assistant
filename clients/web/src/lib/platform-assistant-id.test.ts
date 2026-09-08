import { beforeEach, describe, expect, mock, test } from "bun:test";

const PLATFORM_ASSISTANT_ID = "11111111-1111-4111-8111-111111111111";

const resolveLocalAssistantPlatformIdentityMock = mock(
  async (assistantId: string) => assistantId,
);
const resolvePairedAssistantPlatformIdMock = mock(
  async (_assistantId: string) => null as string | null,
);
const fetchPlatformStatusMock = mock(
  async (): Promise<{ assistantId: string } | null> => null,
);
let remoteGatewayMode = false;
let remoteGatewayBaseUrl = "https://gateway.example.com";

mock.module("@/lib/auth/remote-gateway-session", () => ({
  remoteGatewayPublicBaseUrl: () => remoteGatewayBaseUrl,
}));
mock.module("@/lib/local-platform-identity", () => ({
  isUuid: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
  resolveLocalAssistantPlatformIdentity:
    resolveLocalAssistantPlatformIdentityMock,
  fetchPlatformStatus: fetchPlatformStatusMock,
}));
mock.module("@/lib/paired-platform-identity", () => ({
  resolvePairedAssistantPlatformId: resolvePairedAssistantPlatformIdMock,
}));
mock.module("@/lib/local-mode", () => ({
  isRemoteGatewayMode: () => remoteGatewayMode,
}));
mock.module("@/lib/self-hosted/connection", () => ({
  getSelfHostedActorToken: () => "actor-token",
}));

const { resolvePlatformAssistantId } = await import(
  "@/lib/platform-assistant-id"
);

beforeEach(() => {
  remoteGatewayMode = false;
  remoteGatewayBaseUrl = "https://gateway.example.com";
  resolveLocalAssistantPlatformIdentityMock.mockClear();
  resolveLocalAssistantPlatformIdentityMock.mockImplementation(
    async (assistantId: string) => assistantId,
  );
  resolvePairedAssistantPlatformIdMock.mockClear();
  resolvePairedAssistantPlatformIdMock.mockImplementation(async () => null);
  fetchPlatformStatusMock.mockClear();
  fetchPlatformStatusMock.mockImplementation(async () => null);
});

describe("resolvePlatformAssistantId", () => {
  test("returns a UUID unchanged", async () => {
    await expect(
      resolvePlatformAssistantId(PLATFORM_ASSISTANT_ID),
    ).resolves.toBe(PLATFORM_ASSISTANT_ID);
    expect(resolveLocalAssistantPlatformIdentityMock).not.toHaveBeenCalled();
  });

  test("resolves a lockfile slug through local platform identity", async () => {
    resolveLocalAssistantPlatformIdentityMock.mockImplementationOnce(
      async () => PLATFORM_ASSISTANT_ID,
    );

    await expect(resolvePlatformAssistantId("local-slug")).resolves.toBe(
      PLATFORM_ASSISTANT_ID,
    );
    expect(resolvePairedAssistantPlatformIdMock).not.toHaveBeenCalled();
  });

  test("falls through to the paired lookup when local identity is not a UUID", async () => {
    resolvePairedAssistantPlatformIdMock.mockImplementationOnce(
      async () => PLATFORM_ASSISTANT_ID,
    );

    await expect(resolvePlatformAssistantId("paired-slug")).resolves.toBe(
      PLATFORM_ASSISTANT_ID,
    );
  });

  test("continues after a local-identity throw", async () => {
    resolveLocalAssistantPlatformIdentityMock.mockImplementationOnce(
      async () => {
        throw new Error("no lockfile");
      },
    );
    resolvePairedAssistantPlatformIdMock.mockImplementationOnce(
      async () => PLATFORM_ASSISTANT_ID,
    );

    await expect(resolvePlatformAssistantId("paired-slug")).resolves.toBe(
      PLATFORM_ASSISTANT_ID,
    );
  });

  test("resolves remote-gateway 'self' through platform status", async () => {
    remoteGatewayMode = true;
    fetchPlatformStatusMock.mockImplementationOnce(async () => ({
      assistantId: PLATFORM_ASSISTANT_ID,
    }));

    await expect(resolvePlatformAssistantId("self")).resolves.toBe(
      PLATFORM_ASSISTANT_ID,
    );
    expect(resolveLocalAssistantPlatformIdentityMock).toHaveBeenCalledWith(
      "self",
      { allowGatewayRepair: false },
    );
    expect(fetchPlatformStatusMock).toHaveBeenCalledWith(
      {
        gatewayUrl: "https://gateway.example.com",
        actorToken: "actor-token",
      },
      "self",
    );
  });

  test("probes platform status through a prefix-served remote-gateway base", async () => {
    remoteGatewayMode = true;
    remoteGatewayBaseUrl = "https://gateway.example.com/assistant-123";
    fetchPlatformStatusMock.mockImplementationOnce(async () => ({
      assistantId: PLATFORM_ASSISTANT_ID,
    }));

    await expect(resolvePlatformAssistantId("self")).resolves.toBe(
      PLATFORM_ASSISTANT_ID,
    );
    expect(fetchPlatformStatusMock).toHaveBeenCalledWith(
      {
        gatewayUrl: "https://gateway.example.com/assistant-123",
        actorToken: "actor-token",
      },
      "self",
    );
  });

  test("returns null when no platform UUID can be resolved", async () => {
    remoteGatewayMode = true;
    await expect(resolvePlatformAssistantId("self")).resolves.toBeNull();
  });
});
