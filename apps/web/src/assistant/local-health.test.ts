import { beforeAll, describe, expect, mock, test } from "bun:test";

import type {
  HealthzProbeResult,
  LocalAssistantHealth,
} from "@/assistant/local-health";

let deriveLocalAssistantHealth: (input: {
  isError: boolean;
  result: HealthzProbeResult | undefined;
}) => LocalAssistantHealth | null;

mock.module("@/assistant/api", () => ({
  getAssistantHealthz: () => {
    throw new Error("not called in these tests");
  },
}));

mock.module("@/hooks/use-platform-gate", () => ({
  useActiveAssistantIsSelfHosted: () => false,
}));

beforeAll(async () => {
  ({ deriveLocalAssistantHealth } = await import("@/assistant/local-health"));
});

describe("deriveLocalAssistantHealth", () => {
  test("returns unreachable when the request errored", () => {
    expect(
      deriveLocalAssistantHealth({ isError: true, result: undefined }),
    ).toBe("unreachable");
  });

  test("returns null before the first probe resolves", () => {
    expect(
      deriveLocalAssistantHealth({ isError: false, result: undefined }),
    ).toBeNull();
  });

  test("returns unreachable for a non-2xx response", () => {
    expect(
      deriveLocalAssistantHealth({
        isError: false,
        result: { ok: false },
      }),
    ).toBe("unreachable");
  });

  test("returns healthy for a healthy status", () => {
    expect(
      deriveLocalAssistantHealth({
        isError: false,
        result: { ok: true, data: { status: "healthy" } },
      }),
    ).toBe("healthy");
  });

  test("returns healthy for an ok status", () => {
    expect(
      deriveLocalAssistantHealth({
        isError: false,
        result: { ok: true, data: { status: "ok" } },
      }),
    ).toBe("healthy");
  });

  test("treats a 2xx response without a status field as healthy", () => {
    expect(
      deriveLocalAssistantHealth({
        isError: false,
        result: { ok: true, data: {} },
      }),
    ).toBe("healthy");
  });

  test("returns unhealthy for any other reported status", () => {
    expect(
      deriveLocalAssistantHealth({
        isError: false,
        result: { ok: true, data: { status: "degraded" } },
      }),
    ).toBe("unhealthy");
  });
});
