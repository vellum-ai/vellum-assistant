import { beforeEach, describe, expect, test } from "bun:test";
import type { SubagentStatus } from "@vellumai/assistant-api";

import { reconcileSubagentStoreFromNotifications } from "@/domains/chat/hooks/reconcile-subagent-hydration";
import { useSubagentStore } from "@/domains/chat/subagent-store";

const NOW = 1700000000000;

function store() {
  return useSubagentStore.getState();
}

function spawn(id: string, status: SubagentStatus) {
  store().spawnSubagent({
    subagentId: id,
    label: id,
    objective: "",
    timestamp: NOW,
    status,
  });
}

beforeEach(() => {
  store().reset();
});

describe("reconcileSubagentStoreFromNotifications", () => {
  test("preserves a live in-flight subagent that has no notification yet", () => {
    // The bug: a subagent still running when the conversation re-hydrates
    // (e.g. after a tab switch) must not be dropped.
    spawn("live", "running");
    reconcileSubagentStoreFromNotifications(
      store(),
      [{ subagentId: "done", label: "done", status: "completed" }],
      NOW,
    );
    expect(store().byId["live"]?.status).toBe("running"); // live preserved
    expect(store().byId["done"]?.status).toBe("completed"); // notified added
  });

  test("rebuilds from notifications (clears stale terminal entries) when nothing is in flight", () => {
    spawn("old", "completed"); // terminal entry from a prior conversation
    reconcileSubagentStoreFromNotifications(
      store(),
      [{ subagentId: "new", label: "new", status: "completed" }],
      NOW,
    );
    expect(store().byId["old"]).toBeUndefined(); // reset cleared it
    expect(store().byId["new"]?.status).toBe("completed");
  });

  test("applies a terminal notification to a live entry without dropping it", () => {
    spawn("sub", "running");
    reconcileSubagentStoreFromNotifications(
      store(),
      [
        {
          subagentId: "sub",
          label: "sub",
          status: "completed",
          conversationId: "conv-x",
        },
      ],
      NOW,
    );
    expect(store().byId["sub"]).toBeDefined();
    expect(store().byId["sub"]?.status).toBe("completed");
    expect(store().byId["sub"]?.conversationId).toBe("conv-x");
  });
});
