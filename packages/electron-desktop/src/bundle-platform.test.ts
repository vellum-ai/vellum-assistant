import { beforeEach, expect, mock, test } from "bun:test";

interface LockfileResult {
  ok: true;
  data: {
    activeAssistant: string | null;
    assistants: Array<{
      assistantId: string;
      resources?: { gatewayPort?: number };
    }>;
  };
}

const getLockfileData = mock(
  (): LockfileResult => ({
    ok: true as const,
    data: {
      activeAssistant: "assistant-1" as string | null,
      assistants: [
        {
          assistantId: "assistant-1",
          resources: { gatewayPort: 9000 },
        },
      ],
    },
  }),
);

mock.module("@vellumai/local-mode", () => ({ getLockfileData }));

const { resolveActiveBundleGateway } = await import("./bundle-platform");

beforeEach(() => {
  getLockfileData.mockClear();
});

test("resolves the active assistant's gateway", () => {
  expect(resolveActiveBundleGateway(["C:\\Vellum\\lock.json"])).toEqual({
    assistantId: "assistant-1",
    port: 9000,
  });
});

test("rejects a lockfile without an active gateway", () => {
  getLockfileData.mockReturnValueOnce({
    ok: true,
    data: { activeAssistant: null, assistants: [] },
  });

  expect(resolveActiveBundleGateway(["C:\\Vellum\\lock.json"])).toBeNull();
});
