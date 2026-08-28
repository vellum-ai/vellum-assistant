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
