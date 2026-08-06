/**
 * A scheduled, heartbeat, or background turn runs its document tools in a
 * sidecar worker, whose local hub has no SSE subscriber. The documents-changed
 * broadcast has to be handed to the daemon there, or the document edited while
 * the user was not looking stays invisible on every client.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let notifyCount = 0;

mock.module("./worker-daemon-notify.js", () => ({
  NOTIFY_CONVERSATION_PERSISTED_IPC_METHOD:
    "notify_conversation_persisted_externally",
  NOTIFY_DOCUMENTS_CHANGED_IPC_METHOD: "notify_documents_changed_externally",
  notifyDaemonConversationPersisted: async () => {},
  notifyDaemonDocumentsChanged: async () => {
    notifyCount++;
  },
}));

import type { AssistantEventEnvelope } from "../../api/index.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import {
  _resetStreamStateForTesting,
  disableStreamSeqStamping,
} from "../assistant-stream-state.js";
import {
  DOCUMENTS_CHANGED_COALESCE_MS,
  publishDocumentsChanged,
} from "./resource-sync-events.js";

async function settle(): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, DOCUMENTS_CHANGED_COALESCE_MS + 50),
  );
}

/** Run `publish`, then return the `sync_changed` events it put on the hub. */
async function captureLocalPublishes(
  publish: () => void,
): Promise<AssistantEventEnvelope[]> {
  await settle();
  const received: AssistantEventEnvelope[] = [];
  const subscription = assistantEventHub.subscribe({
    type: "process",
    callback: (event) => {
      if (event.message.type === "sync_changed") {
        received.push(event);
      }
    },
  });
  try {
    publish();
    await settle();
    return received;
  } finally {
    subscription.dispose();
  }
}

describe("publishDocumentsChanged in a sidecar worker", () => {
  beforeEach(async () => {
    await settle();
    notifyCount = 0;
    _resetStreamStateForTesting();
  });

  test("hands the broadcast to the daemon instead of publishing into a void", async () => {
    disableStreamSeqStamping();

    const events = await captureLocalPublishes(() => {
      publishDocumentsChanged();
    });

    expect(notifyCount).toBe(1);
    expect(events).toEqual([]);
  });

  test("coalesces a burst of worker writes into one hand-off", async () => {
    disableStreamSeqStamping();

    await captureLocalPublishes(() => {
      for (let i = 0; i < 10; i++) {
        publishDocumentsChanged();
      }
    });

    expect(notifyCount).toBe(1);
  });

  test("publishes on the local hub in the daemon, where subscribers live", async () => {
    const events = await captureLocalPublishes(() => {
      publishDocumentsChanged();
    });

    expect(notifyCount).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0].message).toMatchObject({ type: "sync_changed" });
  });
});
