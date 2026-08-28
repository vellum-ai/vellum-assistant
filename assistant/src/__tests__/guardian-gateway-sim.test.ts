import { describe, expect, test } from "bun:test";

import { createGuardianGatewaySim } from "./guardian-gateway-sim.js";

import "./test-preload.js";

/**
 * Pins the simulator to the gateway's authorization-lifecycle contract.
 * Fifteen assistant suites prove behavior against this sim, so a sim whose
 * semantics drift from the gateway's lets them pass against a production
 * shape that does not exist.
 */
describe("guardian gateway sim: boot expiry contract", () => {
  test("expires only interaction-bound kinds, never persistent kinds", async () => {
    const sim = createGuardianGatewaySim();
    const past = Date.now() - 60_000;
    sim.seedRequest({ id: "ta", kind: "tool_approval", status: "pending" });
    sim.seedRequest({
      id: "pq",
      kind: "pending_question",
      status: "pending",
    });
    // Past-deadline persistent rows stay pending for the sweep, which owns
    // the card-withdrawal and requester-notice fan-out; boot must not
    // pre-empt it (the gateway contract this sim mirrors).
    sim.seedRequest({
      id: "ar",
      kind: "access_request",
      status: "pending",
      expiresAt: past,
    });
    sim.seedRequest({
      id: "tg",
      kind: "tool_grant_request",
      status: "pending",
      expiresAt: past,
    });

    const expired = await sim.module.expireInteractionBoundGuardianRequests();

    expect(expired).toBe(2);
    expect(sim.getRequest("ta")?.status).toBe("expired");
    expect(sim.getRequest("pq")?.status).toBe("expired");
    expect(sim.getRequest("ar")?.status).toBe("pending");
    expect(sim.getRequest("tg")?.status).toBe("pending");
  });
});

describe("guardian gateway sim: decision arbitration contract", () => {
  test("a decision past the deadline loses atomically", async () => {
    const sim = createGuardianGatewaySim();
    sim.seedRequest({
      id: "late",
      kind: "access_request",
      status: "pending",
      expiresAt: Date.now() - 1000,
    });

    const result = await sim.module.decideGuardianRequest({
      id: "late",
      expectedStatus: "pending",
      status: "approved",
    });

    expect(result.applied).toBe(false);
    expect(sim.getRequest("late")?.status).toBe("pending");
  });

  test("a no-op expire never restamps a decided request's deliveries", async () => {
    const sim = createGuardianGatewaySim();
    sim.seedRequest({ id: "done", kind: "access_request", status: "pending" });
    sim.seedDelivery({
      id: "d1",
      requestId: "done",
      destinationChannel: "telegram",
      destinationChatId: "chat-1",
      status: "sent",
    });
    await sim.module.decideGuardianRequest({
      id: "done",
      expectedStatus: "pending",
      status: "approved",
    });

    await sim.module.expireGuardianRequest("done");

    expect(sim.getRequest("done")?.status).toBe("approved");
    expect(sim.deliveries.find((d) => d.id === "d1")?.status).toBe("sent");
  });

  test("a withdrawn delivery keeps its receipt through the expire flip", async () => {
    const sim = createGuardianGatewaySim();
    sim.seedRequest({ id: "exp", kind: "access_request", status: "pending" });
    sim.seedDelivery({
      id: "kept",
      requestId: "exp",
      destinationChannel: "telegram",
      destinationChatId: "chat-1",
      status: "withdrawn",
    });
    sim.seedDelivery({
      id: "flipped",
      requestId: "exp",
      destinationChannel: "vellum",
      destinationConversationId: "conv-1",
      status: "sent",
    });

    await sim.module.expireGuardianRequest("exp");

    expect(sim.getRequest("exp")?.status).toBe("expired");
    expect(sim.deliveries.find((d) => d.id === "kept")?.status).toBe(
      "withdrawn",
    );
    expect(sim.deliveries.find((d) => d.id === "flipped")?.status).toBe(
      "expired",
    );
  });
});
