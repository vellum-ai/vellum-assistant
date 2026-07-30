/**
 * Admission policy enforcement stage.
 *
 * Sits between the verdict-derived trust context (`trustContextFromVerdict()`
 * over the gateway-stamped verdict) and the agent-loop dispatch in
 * `inbound-message-handler.ts`. The gateway attaches a per-channel-type
 * floor (`sourceMetadata.admissionPolicy`); this stage compares the floor
 * to the resolved trust class's rank and either admits or denies.
 *
 * The decision itself (`enforceAdmissionPolicy`) lives in
 * `@vellumai/gateway-client` (`admission-enforcement.ts`) — one shared
 * implementation, also evaluated by the gateway's channel-command
 * authorization seam for gateway-terminal commands like `/new`. This module
 * is the runtime-facing surface and keeps the runtime deny semantics
 * documented next to their consumers.
 *
 * Deny semantics — see `wave-b-plan.md` §8.2:
 *
 * - `shouldChallenge: true` when the policy is one that re-verification
 *   could lift past (`any_contact`, `strangers`). The caller fires the
 *   existing Slack DM / email upgrade UX so the sender knows verification
 *   would admit them.
 * - `shouldChallenge: false` for the stricter floors (`guardian_only`,
 *   `trusted_contacts`). Denials are silent — sender gets the standard
 *   canned reply; guardian still gets the access-request notification.
 *
 * Blocked / revoked members short-circuit to deny regardless of policy.
 * The gateway kill switch (`no_one`) is enforced before forwarding, so
 * this stage never sees a `no_one` policy on the wire; the shared
 * implementation still handles the value for defense in depth and
 * unit-test reachability.
 */

export {
  type AdmissionDenyReason,
  type AdmissionPolicyInput,
  type AdmissionPolicyResult,
  enforceAdmissionPolicy,
} from "@vellumai/gateway-client";
