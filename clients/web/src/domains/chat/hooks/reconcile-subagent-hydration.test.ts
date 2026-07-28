import { beforeEach, describe, expect, test } from "bun:test";
import type { SubagentStatus } from "@vellumai/assistant-api";

import { reconcileSubagentStoreFromNotifications } from "@/domains/chat/hooks/reconcile-subagent-hydration";
import { useSubagentStore } from "@/domains/chat/subagent-store";

const NOW = 1700000000000;
const PARENT = "conv-parent";

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
      PARENT,
      NOW,
    );
    expect(store().byId["live"]?.status).toBe("running"); // live preserved
    expect(store().byId["done"]?.status).toBe("completed"); // notified added
  });

  test("keeps a terminal entry reconcile recovered but no notification mentions", () => {
    // A silent run, one that streamed nothing, is recovered from the daemon's
    // durable rows as `interrupted`, so it appears in no history notification.
    // Hydration is additive; deleting it would make its visibility depend on
    // which request finished first. Cross-conversation cleanup belongs to the
    // conversation-change reset, not here.
    spawn("silent", "interrupted");
    reconcileSubagentStoreFromNotifications(
      store(),
      [{ subagentId: "new", label: "new", status: "completed" }],
      PARENT,
      NOW,
    );
    expect(store().byId["silent"]?.status).toBe("interrupted");
    expect(store().byId["new"]?.status).toBe("completed");
  });

  test("never deletes entries, even with nothing in flight and no notifications", () => {
    spawn("old", "completed");
    reconcileSubagentStoreFromNotifications(store(), [], PARENT, NOW);
    expect(store().byId["old"]?.status).toBe("completed");
  });

  test("a stale running notification cannot regress a settled entry", () => {
    // Restart ordering: reconcile settles a silent run as `interrupted`
    // (durable-row recovery), then history hydration replays the run's
    // MID-RUN notification whose status is still `running`. The run will
    // emit no further terminal event, so regressing here would stick the
    // overlay and Stop control forever.
    spawn("settled", "interrupted");
    reconcileSubagentStoreFromNotifications(
      store(),
      [
        {
          subagentId: "settled",
          label: "settled",
          status: "running",
          conversationId: "child-conv",
        },
      ],
      PARENT,
      NOW,
    );
    expect(store().byId["settled"]?.status).toBe("interrupted");
    // The non-status fields still land, the notification remains a valid
    // source for identity/conversation wiring.
    expect(store().byId["settled"]?.conversationId).toBe("child-conv");
    expect(store().byId["settled"]?.parentConversationId).toBe(PARENT);
  });

  test("a terminal-to-terminal notification still applies to a settled entry", () => {
    // Only the terminal→active direction is blocked: a notification carrying
    // a truer terminal state (e.g. `failed` over provisional `interrupted`)
    // must still land.
    spawn("settled2", "interrupted");
    reconcileSubagentStoreFromNotifications(
      store(),
      [{ subagentId: "settled2", label: "settled2", status: "failed" }],
      PARENT,
      NOW,
    );
    expect(store().byId["settled2"]?.status).toBe("failed");
  });

  test("applies a terminal notification to a settled entry without dropping it", () => {
    spawn("sub", "interrupted");
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
      PARENT,
      NOW,
    );
    expect(store().byId["sub"]?.status).toBe("completed");
    expect(store().byId["sub"]?.conversationId).toBe("conv-x");
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
      PARENT,
      NOW,
    );
    expect(store().byId["sub"]).toBeDefined();
    expect(store().byId["sub"]?.status).toBe("completed");
    expect(store().byId["sub"]?.conversationId).toBe("conv-x");
  });

  test("stamps the child id from the notification and the parent id from the arg on a fresh spawn", () => {
    reconcileSubagentStoreFromNotifications(
      store(),
      [
        {
          subagentId: "fresh",
          label: "fresh",
          status: "running",
          conversationId: "conv-child",
        },
      ],
      PARENT,
      NOW,
    );

    const entry = store().byId["fresh"]!;
    expect(entry.conversationId).toBe("conv-child");
    expect(entry.parentConversationId).toBe(PARENT);
  });

  test("anchors an entry reconcile recovered to its spawning message", () => {
    // Reconcile materializes rows with no parent message id at all, so
    // `byParent` has no bucket for them and the transcript can't place their
    // inline card. The notification is the only source that names the message.
    spawn("silent", "completed");
    expect(useSubagentStore.getState().byParent.size).toBe(0);

    reconcileSubagentStoreFromNotifications(
      store(),
      [
        {
          subagentId: "silent",
          label: "silent",
          status: "completed",
          parentMessageId: "msg-1",
        },
      ],
      PARENT,
      NOW,
    );

    expect(store().byId["silent"]?.parentMessageId).toBe("msg-1");
    expect(
      useSubagentStore.getState().byParent.get("msg-1")?.map((e) => e.subagentId),
    ).toEqual(["silent"]);
  });

  test("leaves an entry already anchored to its message alone", () => {
    store().spawnSubagent({
      subagentId: "anchored",
      label: "anchored",
      objective: "",
      timestamp: NOW,
      status: "running",
      parentMessageId: "msg-original",
    });

    reconcileSubagentStoreFromNotifications(
      store(),
      [
        {
          subagentId: "anchored",
          label: "anchored",
          status: "running",
          parentMessageId: "msg-other",
        },
      ],
      PARENT,
      NOW,
    );

    expect(store().byId["anchored"]?.parentMessageId).toBe("msg-original");
  });

  test("names a blank stub from the notification", () => {
    // A stub materialized from a bare `subagent_status_changed` has no label
    // at all; without this it stays blank for the rest of the session.
    store().ensureEntry({ subagentId: "stub", timestamp: NOW, status: "running" });
    expect(store().byId["stub"]?.label).toBe("");

    reconcileSubagentStoreFromNotifications(
      store(),
      [
        {
          subagentId: "stub",
          label: "Audit defenses",
          status: "running",
          objective: "Check the locks",
        },
      ],
      PARENT,
      NOW,
    );

    expect(store().byId["stub"]?.label).toBe("Audit defenses");
    expect(store().byId["stub"]?.objective).toBe("Check the locks");
  });

  test("does not overwrite an identity the entry already has", () => {
    // `subagent_spawned` is the same source of truth, seen first-hand.
    spawn("named", "running"); // label === "named"
    reconcileSubagentStoreFromNotifications(
      store(),
      [{ subagentId: "named", label: "Different", status: "running" }],
      PARENT,
      NOW,
    );

    expect(store().byId["named"]?.label).toBe("named");
  });

  test("stamps the parent id on a live entry via the merge path", () => {
    spawn("sub", "running");
    reconcileSubagentStoreFromNotifications(
      store(),
      [{ subagentId: "sub", label: "sub", status: "running" }],
      PARENT,
      NOW,
    );

    expect(store().byId["sub"]?.parentConversationId).toBe(PARENT);
  });

  test("an out-of-enum status leaves a live entry's status alone", () => {
    spawn("sub", "running");
    reconcileSubagentStoreFromNotifications(
      store(),
      [
        {
          subagentId: "sub",
          label: "sub",
          status: "bogus",
          conversationId: "conv-child",
        },
      ],
      PARENT,
      NOW,
    );

    expect(store().byId["sub"]?.status).toBe("running");
    expect(store().byId["sub"]?.conversationId).toBe("conv-child");
    expect(store().byId["sub"]?.parentConversationId).toBe(PARENT);
  });

  test("an out-of-enum status falls back to completed on a fresh spawn", () => {
    reconcileSubagentStoreFromNotifications(
      store(),
      [{ subagentId: "hist", label: "hist", status: "bogus" }],
      PARENT,
      NOW,
    );

    expect(store().byId["hist"]?.status).toBe("completed");
  });
});
