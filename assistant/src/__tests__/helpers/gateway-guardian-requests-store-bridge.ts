/**
 * Test-only in-memory fake serving the daemon's gateway guardian-request
 * client surface. Rows live in a `guardian-gateway-sim` instance — the same
 * fake the decide-cluster suites use — with two wire-parity layers on top:
 *
 * - Create/decide/delivery params are validated against the shared contract
 *   schemas (the validation the gateway route applies), so malformed daemon
 *   params fail here exactly as they would on the wire, and decisionable
 *   kinds without a `guardianPrincipalId` are rejected like the gateway
 *   store's integrity guard.
 * - Decide applies `aclOutcome` through the daemon relay each outcome
 *   variant maps to (member activation/seed/block, outbound-session mint),
 *   so suites observe the same ACL writes the gateway transaction performs;
 *   an outcome failure reverts the status CAS, mirroring the transaction
 *   rollback.
 *
 * Wire it in with a module mock:
 *
 *   mock.module("../channels/gateway-guardian-requests.js", () =>
 *     gatewayGuardianRequestsStoreBridge,
 *   );
 *
 * Suites seed and inspect rows through the exported `bridgeState` sim
 * handle (`bridgeState.seedRequest(...)`, `bridgeState.deliveries`,
 * `bridgeState.reset()` in beforeEach, ...).
 */

import {
  type CreateGuardianRequestDeliveryIpcParams,
  CreateGuardianRequestDeliveryIpcParamsSchema,
  type CreateGuardianRequestIpcParams,
  CreateGuardianRequestIpcParamsSchema,
  type DecideGuardianRequestIpcParams,
  DecideGuardianRequestIpcParamsSchema,
  type DecideGuardianRequestIpcResponse,
  type GuardianRequestAclOutcome,
} from "@vellumai/gateway-client";

import {
  createGuardianGatewaySim,
  type SimGuardianDelivery,
  type SimGuardianRequest,
} from "../guardian-gateway-sim.js";

/** Backing rows + failure-injection seams; reset between tests. */
export const bridgeState = createGuardianGatewaySim();

async function createGuardianRequest(
  params: CreateGuardianRequestIpcParams,
): Promise<SimGuardianRequest> {
  // The schema requires `guardianPrincipalId`, mirroring the gateway store's
  // integrity guard (every contract kind is decisionable).
  return bridgeState.seedRequest(
    CreateGuardianRequestIpcParamsSchema.parse(params),
  );
}

async function createGuardianRequestDelivery(
  params: CreateGuardianRequestDeliveryIpcParams,
): Promise<SimGuardianDelivery> {
  return bridgeState.seedDelivery(
    CreateGuardianRequestDeliveryIpcParamsSchema.parse(params),
  );
}

/**
 * Apply the decision's ACL outcome through the daemon relay each variant
 * maps to (per the contract), so tests observe the same ACL writes the
 * gateway transaction performs. Throws when the outcome does not land —
 * the caller reverts the CAS like the gateway transaction rollback.
 * Relay imports are deferred to call time so this helper installs no
 * production coupling before a test's own setup/mocks run.
 */
async function applyAclOutcome(
  outcome: GuardianRequestAclOutcome,
): Promise<{ mintedSession?: DecideAppliedResponse["mintedSession"] }> {
  switch (outcome.type) {
    case "activate_member": {
      const { activateMemberChannel } =
        await import("../../contacts/member-write-relay.js");
      const { type: _type, ...params } = outcome;
      const result = await activateMemberChannel(params);
      if (result.status !== "activated") {
        throw new Error("bridge: gateway refused the member activation");
      }
      return {};
    }
    case "seed_unverified": {
      const { seedUnverifiedMemberChannel } =
        await import("../../contacts/member-write-relay.js");
      const { type: _type, ...params } = outcome;
      await seedUnverifiedMemberChannel(params);
      return {};
    }
    case "block": {
      const { blockSenderChannel } =
        await import("../../contacts/member-write-relay.js");
      const { type: _type, ...params } = outcome;
      const result = await blockSenderChannel(params);
      if (!result.revoked) {
        throw new Error("bridge: block did not land");
      }
      return {};
    }
    case "mint_outbound_session": {
      const { createOutboundSession } =
        await import("../../channels/gateway-verification-sessions.js");
      const { type: _type, ...params } = outcome;
      return { mintedSession: await createOutboundSession(params) };
    }
  }
}

type DecideAppliedResponse = Extract<
  DecideGuardianRequestIpcResponse,
  { applied: true }
>;

async function decideGuardianRequest(
  params: DecideGuardianRequestIpcParams,
): Promise<DecideGuardianRequestIpcResponse> {
  const parsed = DecideGuardianRequestIpcParamsSchema.parse(params);
  const { aclOutcome, ...cas } = parsed;
  const result = await bridgeState.module.decideGuardianRequest(cas);
  if (!result.applied || !aclOutcome) {
    return result as DecideGuardianRequestIpcResponse;
  }

  let mintedSession: DecideAppliedResponse["mintedSession"];
  try {
    ({ mintedSession } = await applyAclOutcome(aclOutcome));
  } catch (err) {
    // Mirror the gateway transaction rollback: the CAS never lands.
    await bridgeState.module.reopenGuardianRequest(parsed.id, parsed.status);
    throw err;
  }

  return {
    applied: true,
    request: result.request,
    ...(mintedSession ? { mintedSession } : {}),
  } as DecideGuardianRequestIpcResponse;
}

/**
 * Module-shaped delegate for `channels/gateway-guardian-requests.js`
 * covering the full client surface (create, delivery recording, and the
 * decide/lookup cluster).
 */
export const gatewayGuardianRequestsStoreBridge = {
  ...bridgeState.module,
  createGuardianRequest,
  createGuardianRequestDelivery,
  decideGuardianRequest,
};
