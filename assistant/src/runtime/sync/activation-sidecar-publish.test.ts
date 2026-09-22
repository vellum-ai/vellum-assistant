/**
 * A scheduled or background turn working a checklist task runs in a sidecar
 * worker, whose local hub has no SSE subscriber. The activation-progress
 * invalidation has to be handed to the daemon there, or the checklist row
 * keeps showing Working on every client until something else refetches it.
 *
 * The two branches are told apart by what reaches the local hub: the daemon
 * publishes there, the worker publishes nothing and calls the daemon over
 * IPC instead (that hand-off is covered in `worker-daemon-notify.test.ts`).
 * No module is mocked here, so nothing this file does can reach a sibling
 * file bun runs in the same process.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { AssistantEventEnvelope } from "../../api/index.js";
import { assistantEventHub } from "../assistant-event-hub.js";
import {
  _resetStreamStateForTesting,
  disableStreamSeqStamping,
} from "../assistant-stream-state.js";
import { publishActivationProgressChanged } from "./resource-sync-events.js";

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
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

describe("publishActivationProgressChanged", () => {
  beforeEach(async () => {
    await settle();
    _resetStreamStateForTesting();
  });

  test("publishes on the local hub in the daemon, where subscribers live", async () => {
    const events = await captureLocalPublishes(() => {
      publishActivationProgressChanged("client-a");
    });

    expect(events).toHaveLength(1);
    expect(events[0].message).toMatchObject({
      type: "sync_changed",
      tags: ["activation:progress"],
    });
  });

  test("publishes nothing locally in a sidecar worker", async () => {
    disableStreamSeqStamping();

    const events = await captureLocalPublishes(() => {
      publishActivationProgressChanged();
    });

    expect(events).toEqual([]);
  });
});
