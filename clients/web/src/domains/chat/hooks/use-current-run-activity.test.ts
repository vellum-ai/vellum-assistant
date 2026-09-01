/**
 * `useCurrentRunActivity` scopes the floating agents control to what is
 * happening NOW: everything still working, plus the finished siblings from the
 * same batch. Sessions from earlier runs are history and must not appear.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// The stores reach the generated daemon SDK, which isn't built in CI/worktree
// checkouts. Stub every endpoint so the modules load; nothing here calls them.
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
const { useCurrentRunActivity } = await import(
  "@/domains/chat/hooks/use-conversation-activity"
);
const { useSubagentStore } = await import("@/domains/chat/subagent-store");

const CONV = "conv-1";
const T0 = 1_700_000_000_000;

function spawn(
  id: string,
  status: "running" | "completed",
  spawnedAt: number,
): void {
  useSubagentStore.getState().spawnSubagent({
    subagentId: id,
    label: id,
    objective: "",
    status,
    conversationId: `child-${id}`,
    parentConversationId: CONV,
    timestamp: spawnedAt,
  });
  // `spawnedAt` is what the run window is measured against; the store stamps it
  // from the spawn payload, so set it explicitly to control the clock here.
  useSubagentStore.setState((s) => ({
    byId: {
      ...s.byId,
      [id]: { ...s.byId[id]!, spawnedAt },
    },
  }));
}

describe("useCurrentRunActivity", () => {
  beforeEach(() => {
    useSubagentStore.getState().reset();
  });

  test("reports nothing when no session is running", () => {
    spawn("old-1", "completed", T0);
    const { result } = renderHook(() => useCurrentRunActivity(CONV));
    // No live work means no current run, whatever history exists.
    expect(result.current.total).toBe(0);
  });

  test("drops finished sessions from an earlier run", () => {
    // A run that ended five minutes ago...
    spawn("counter-1", "completed", T0);
    spawn("counter-2", "completed", T0 + 10);
    // ...and the one happening now.
    spawn("timer-1", "running", T0 + 300_000);

    const { result } = renderHook(() => useCurrentRunActivity(CONV));

    expect(result.current.running.map((r) => r.id)).toEqual(["timer-1"]);
    expect(result.current.completed).toEqual([]);
  });

  test("keeps a sibling that finished within the same batch", () => {
    // Spawned together; the first finished before the last was even created,
    // which is what the tolerance is for.
    spawn("timer-1", "completed", T0);
    spawn("timer-2", "running", T0 + 500);

    const { result } = renderHook(() => useCurrentRunActivity(CONV));

    expect(result.current.running.map((r) => r.id)).toEqual(["timer-2"]);
    expect(result.current.completed.map((r) => r.id)).toEqual(["timer-1"]);
  });

  test("keeps every running session regardless of when it started", () => {
    // A long-lived agent from earlier is still working, so it is still current.
    spawn("long-runner", "running", T0);
    spawn("timer-1", "running", T0 + 600_000);

    const { result } = renderHook(() => useCurrentRunActivity(CONV));

    expect(result.current.running.map((r) => r.id).sort()).toEqual([
      "long-runner",
      "timer-1",
    ]);
  });
});
