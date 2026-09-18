import { afterEach, describe, expect, test } from "bun:test";

import { assistantEventHub } from "../assistant-event-hub.js";
import * as pendingInteractions from "../pending-interactions.js";
import { ForbiddenError } from "./errors.js";
import { assertHostProxyResultBinding } from "./host-proxy-result-binding.js";

const ACTOR = "actor-host-proxy-bind";
const subscriptions: Array<{ dispose(): void }> = [];

function subscribeClient(clientId: string) {
  const sub = assistantEventHub.subscribe({
    type: "client",
    clientId,
    interfaceId: "macos",
    capabilities: ["host_bash"],
    actorPrincipalId: ACTOR,
    callback: () => {},
  });
  subscriptions.push(sub);
  return sub;
}

describe("assertHostProxyResultBinding connection snapshot", () => {
  afterEach(() => {
    pendingInteractions.clear();
    for (const sub of subscriptions.splice(0)) {
      sub.dispose();
    }
  });

  test("allows a result while the dispatch connection is still active", async () => {
    const sub = subscribeClient("host-proxy-bind-1");
    pendingInteractions.register("req-active", {
      kind: "host_bash",
      targetClientId: "host-proxy-bind-1",
    });
    const pending = pendingInteractions.get("req-active");
    expect(pending?.targetConnectionId).toBe(sub.connectionId);

    await assertHostProxyResultBinding({
      headers: {
        "x-vellum-client-id": "host-proxy-bind-1",
        "x-vellum-actor-principal-id": ACTOR,
      },
      targetClientId: pending?.targetClientId,
      targetConnectionId: pending?.targetConnectionId,
      targetActorPrincipalId: ACTOR,
      op: "host_bash",
      missingClientIdMessage: "missing",
    });
    sub.dispose();
  });

  test("rejects a result after the same clientId reconnects", async () => {
    const first = subscribeClient("host-proxy-bind-2");
    pendingInteractions.register("req-stale", {
      kind: "host_bash",
      targetClientId: "host-proxy-bind-2",
    });
    const pending = pendingInteractions.get("req-stale");
    expect(pending?.targetConnectionId).toBe(first.connectionId);

    const second = subscribeClient("host-proxy-bind-2");
    expect(first.active).toBe(false);
    expect(second.connectionId).not.toBe(first.connectionId);

    await expect(
      assertHostProxyResultBinding({
        headers: {
          "x-vellum-client-id": "host-proxy-bind-2",
          "x-vellum-actor-principal-id": ACTOR,
        },
        targetClientId: pending?.targetClientId,
        targetConnectionId: pending?.targetConnectionId,
        targetActorPrincipalId: ACTOR,
        op: "host_bash",
        missingClientIdMessage: "missing",
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    second.dispose();
  });
});
