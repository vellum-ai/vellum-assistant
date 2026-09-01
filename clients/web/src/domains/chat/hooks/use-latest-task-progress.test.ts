import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Surface } from "@/domains/chat/types/types";

// The chat-session store pulls in the generated daemon SDK, which isn't built
// in CI / worktree checkouts. Stub every endpoint so the module loads; nothing
// here invokes them. Export names are read off the real module rather than
// listed by hand, matching the sibling transcript tests: a Proxy doesn't work,
// because ESM resolves named exports at link time and never consults the trap.
const sdkStub = async () => ({ data: undefined });
const realSdkPath = new URL(
  "../../../generated/daemon/sdk.gen.ts",
  import.meta.url,
).pathname;
const sdkSource = await Bun.file(realSdkPath).text();
const exportNames = [...sdkSource.matchAll(/^export const (\w+)/gm)].map(
  (m) => m[1]!,
);
mock.module("@/generated/daemon/sdk.gen", () =>
  Object.fromEntries(exportNames.map((n) => [n, sdkStub])),
);

const { renderHook } = await import("@testing-library/react");
const { useLatestTaskProgress } = await import(
  "@/domains/chat/hooks/use-latest-task-progress"
);
const { useChatSessionStore } = await import(
  "@/domains/chat/chat-session-store"
);

function planSurface(surfaceId: string, title: string): Surface {
  return {
    surfaceId,
    type: "card",
    data: {
      template: "task_progress",
      templateData: {
        title,
        status: "in_progress",
        steps: [{ label: "Create the interface" }],
      },
    },
  } as unknown as Surface;
}

function otherSurface(surfaceId: string): Surface {
  return {
    surfaceId,
    type: "card",
    data: { template: "weather_forecast", templateData: { steps: [] } },
  } as unknown as Surface;
}

function seed(messages: unknown[]) {
  useChatSessionStore.setState({
    snapshot: { messages } as never,
    optimisticSends: [],
    dismissedSurfaceIds: new Set<string>(),
  } as never);
}

function message(id: string, surfaces?: Surface[]) {
  return { id, role: "assistant", timestamp: 1_000, surfaces };
}

describe("useLatestTaskProgress", () => {
  test("finds a finished plan too, leaving liveness to the caller", () => {
    // The scan reaches into server history, so a thread opened fresh resolves
    // whatever plan it finds there. Distinguishing a live plan from one that
    // ended before this session is `ProgressCard`'s job, not this hook's.
    seed([
      message("m1", [
        {
          surfaceId: "done",
          type: "card",
          data: {
            template: "task_progress",
            templateData: {
              title: "Yesterday",
              status: "completed",
              steps: [{ label: "Step", status: "completed" }],
            },
          },
        } as unknown as Surface,
      ]),
    ]);
    const { result } = renderHook(() => useLatestTaskProgress());
    expect(result.current?.surfaceId).toBe("done");
  });

  beforeEach(() => {
    seed([]);
  });

  test("returns null when the thread has no plan", () => {
    seed([message("m1"), message("m2", [otherSurface("s1")])]);
    const { result } = renderHook(() => useLatestTaskProgress());
    expect(result.current).toBeNull();
  });

  test("finds the plan card on the newest message that has one", () => {
    seed([
      message("m1", [planSurface("old", "Old plan")]),
      message("m2"),
      message("m3", [planSurface("new", "New plan")]),
    ]);
    const { result } = renderHook(() => useLatestTaskProgress());
    expect(result.current?.surfaceId).toBe("new");
  });

  test("a later plan in the SAME message supersedes an earlier one", () => {
    seed([
      message("m1", [planSurface("first", "First"), planSurface("second", "Second")]),
    ]);
    const { result } = renderHook(() => useLatestTaskProgress());
    expect(result.current?.surfaceId).toBe("second");
  });

  test("ignores surfaces that aren't task-progress cards", () => {
    seed([
      message("m1", [planSurface("plan", "Plan")]),
      message("m2", [otherSurface("weather")]),
    ]);
    const { result } = renderHook(() => useLatestTaskProgress());
    // The weather card on the newer message must not shadow the real plan.
    expect(result.current?.surfaceId).toBe("plan");
  });

  test("stops scanning past the bound, so an ancient plan is not resurfaced", () => {
    // 40 is the scan bound; a plan sitting behind 60 plan-less replies is
    // history, not progress.
    const messages = [
      message("ancient", [planSurface("ancient-plan", "Ancient")]),
      ...Array.from({ length: 60 }, (_, i) => message(`m${i}`)),
    ];
    seed(messages);
    const { result } = renderHook(() => useLatestTaskProgress());
    expect(result.current).toBeNull();
  });
});
