import { beforeEach, describe, expect, mock, test } from "bun:test";

// Drive the assistant-API-key read that classifyMissingPlatformCredential()
// performs. This is the seam managed-profiles used to mock directly; the
// reachability classification now lives here in client.ts (the module
// authorized to import secure-keys), so the present-but-unusable and
// thrown-read branches are covered here.
let mockApiKey: () => Promise<{
  value: string | undefined;
  unreachable: boolean;
}> = async () => ({ value: undefined, unreachable: false });

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyResultAsync: () => mockApiKey(),
}));

// Sibling test files (managed-profiles.test.ts) register a process-global
// `mock.module("../client.js", ...)` that replaces the real
// classifyMissingPlatformCredential with a stub. bun evaluates every test
// module up front, so that stub clobbers our import regardless of run order.
// Load the real module fresh (bypassing the registered module mock) so we
// exercise the actual classification logic under test.
async function loadReal(): Promise<{
  classifyMissingPlatformCredential: () => Promise<"absent" | "unreachable">;
}> {
  return import(
    `../client.ts?real=${Math.random().toString(36).slice(2)}`
  ) as Promise<{
    classifyMissingPlatformCredential: () => Promise<"absent" | "unreachable">;
  }>;
}

describe("classifyMissingPlatformCredential", () => {
  beforeEach(() => {
    mockApiKey = async () => ({ value: undefined, unreachable: false });
  });

  test("returns 'absent' when the credential read succeeds and is empty", async () => {
    mockApiKey = async () => ({ value: undefined, unreachable: false });
    const { classifyMissingPlatformCredential } = await loadReal();
    expect(await classifyMissingPlatformCredential()).toBe("absent");
  });

  test("returns 'unreachable' when the credential backend is unreachable", async () => {
    mockApiKey = async () => ({ value: undefined, unreachable: true });
    const { classifyMissingPlatformCredential } = await loadReal();
    expect(await classifyMissingPlatformCredential()).toBe("unreachable");
  });

  test("returns 'unreachable' when the key is present but the client is still unavailable", async () => {
    mockApiKey = async () => ({ value: "sk-abc", unreachable: false });
    const { classifyMissingPlatformCredential } = await loadReal();
    expect(await classifyMissingPlatformCredential()).toBe("unreachable");
  });

  test("returns 'unreachable' when the credential read throws", async () => {
    mockApiKey = async () => {
      throw new Error("backend exploded");
    };
    const { classifyMissingPlatformCredential } = await loadReal();
    expect(await classifyMissingPlatformCredential()).toBe("unreachable");
  });
});
