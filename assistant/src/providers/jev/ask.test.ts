import { afterAll, describe, expect, mock, test } from "bun:test";

import type { Provider } from "../types.js";

let configured: {
  provider: Provider;
  configuredProviderName: string;
  entryRouted: boolean;
} | null = null;

const actual = await import("../provider-send-message.js");
mock.module("../provider-send-message.js", () => ({
  ...actual,
  resolveConfiguredProvider: async () => configured,
}));

const { resolveTypesafeProvider } = await import("./ask.js");

afterAll(() => {
  mock.restore();
});

function stub(name: string): Provider {
  return {
    name,
    defaultModel: "jev-latest",
    sendMessage: async () => {
      throw new Error("not dispatched in this test");
    },
  } as unknown as Provider;
}

describe("resolveTypesafeProvider", () => {
  test("a BYOK TypeSafe profile resolves", async () => {
    configured = {
      provider: stub("typesafe"),
      configuredProviderName: "typesafe",
      entryRouted: false,
    };
    expect((await resolveTypesafeProvider("voiceEscalationJudge"))?.name).toBe(
      "typesafe",
    );
  });

  test("a managed Jev profile resolves although it is configured as vellum", async () => {
    configured = {
      provider: stub("typesafe"),
      configuredProviderName: "vellum",
      entryRouted: false,
    };
    expect((await resolveTypesafeProvider("voiceEscalationJudge"))?.name).toBe(
      "typesafe",
    );
  });

  test("any other dispatched provider is unavailable", async () => {
    configured = {
      provider: stub("anthropic"),
      configuredProviderName: "vellum",
      entryRouted: false,
    };
    expect(await resolveTypesafeProvider("voiceEscalationJudge")).toBeNull();
    configured = null;
    expect(await resolveTypesafeProvider("voiceEscalationJudge")).toBeNull();
  });
});
