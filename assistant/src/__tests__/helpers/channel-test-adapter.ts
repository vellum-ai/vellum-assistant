/**
 * Backward-compatible test adapter for channel route handlers.
 *
 * The production handlers now accept {@link RouteHandlerArgs} and resolve
 * deps via direct module imports. This adapter preserves the old
 * `(Request, processMessage?, assistantId?)` call convention so existing
 * tests don't need 200+ mechanical call-site changes.
 *
 * ## processMessage mocking
 *
 * The inbound handler imports `processMessage` directly from
 * `daemon/process-message.js`. Tests that need to intercept or spy on
 * processMessage should call `setAdapterProcessMessage(fn)` before
 * invoking `handleChannelInbound`. The mock.module below routes all
 * processMessage calls through the adapter's override when set; when
 * unset it returns a safe no-op result.
 *
 * Tests should reset the override in `beforeEach` via
 * `setAdapterProcessMessage(undefined)`.
 */

import { mock } from "bun:test";

// ---------------------------------------------------------------------------
// Module-level processMessage + approval-generators mock.
//
// Declared here (in the adapter) rather than in each test file so that
// the mock is registered BEFORE any transitive import of the handler
// module (which statically imports process-message.js). Because this
// file is imported by test files, the mock.module calls execute when
// the adapter module is first loaded — before the handler's own import
// of process-message.js resolves.
// ---------------------------------------------------------------------------

let _adapterProcessMessage: ((...args: any[]) => any) | undefined;

/**
 * Set or clear the processMessage override used by the adapter's mock.
 * Pass `undefined` to reset to the default no-op stub.
 */
export function setAdapterProcessMessage(
  fn: ((...args: any[]) => any) | undefined,
): void {
  _adapterProcessMessage = fn;
}

mock.module("../../daemon/process-message.js", () => ({
  resolveTurnChannel: () => "telegram",
  resolveTurnInterface: () => "telegram",

  prepareConversationForMessage: async () => ({}),
  processMessage: (...args: unknown[]) => {
    if (_adapterProcessMessage) return _adapterProcessMessage(...args);
    return Promise.resolve({ messageId: `mock-msg-adapter-${Date.now()}` });
  },
  processMessageInBackground: async () => ({ messageId: "mock-bg" }),
}));

mock.module("../../daemon/approval-generators.js", () => ({
  createApprovalCopyGenerator: () => undefined,
  createApprovalConversationGenerator: () => undefined,
}));

// The inbound pipeline creates guardian requests and delivery rows through
// the gateway client; tests here have no live gateway, so serve that surface
// from the in-memory bridge fake (seed/inspect/reset via its `bridgeState`).
import { gatewayGuardianRequestsStoreBridge } from "./gateway-guardian-requests-store-bridge.js";

mock.module(
  "../../channels/gateway-guardian-requests.js",
  () => gatewayGuardianRequestsStoreBridge,
);

import type { TrustClass, TrustVerdict } from "@vellumai/gateway-client";

import { isChannelId } from "../../channels/types.js";
import { findContactChannel } from "../../contacts/contact-store.js";
import type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
  MessageProcessor,
} from "../../runtime/http-types.js";
import { getCachedMemberAcl } from "../../runtime/member-verdict-cache.js";
import {
  handleChannelDeliveryAck as _handleChannelDeliveryAck,
  handleListDeadLetters as _handleListDeadLetters,
  handleReplayDeadLetters as _handleReplayDeadLetters,
} from "../../runtime/routes/channel-delivery-routes.js";
import {
  handleChannelInbound as _handleChannelInbound,
  handleDeleteConversation as _handleDeleteConversation,
} from "../../runtime/routes/channel-inbound-routes.js";
import { RouteError } from "../../runtime/routes/errors.js";
import { deriveGuardianForChannel } from "./derive-guardian-delivery.js";

/**
 * Wrap a transport-agnostic handler call, converting RouteError throws
 * back to Response objects so existing tests that assert on `.status`
 * and `.json()` continue to work.
 */
async function wrapHandler<T>(fn: () => T | Promise<T>): Promise<Response> {
  try {
    const result = await fn();
    if (result === null || result === undefined) {
      return new Response(null, { status: 204 });
    }
    return Response.json(result);
  } catch (err) {
    if (err instanceof RouteError) {
      return Response.json(
        { error: { code: err.code, message: err.message } },
        { status: err.statusCode },
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// handleChannelInbound adapter
// ---------------------------------------------------------------------------

export async function handleChannelInbound(
  req: Request,
  _processMessage?: MessageProcessor,
  _assistantId?: string,
  _approvalCopyGenerator?: ApprovalCopyGenerator,
  _approvalConversationGenerator?: ApprovalConversationGenerator,
): Promise<Response> {
  const body = await req.json();
  stampTrustVerdict(body);
  return wrapHandler(() => _handleChannelInbound({ body }));
}

/**
 * Mirror the gateway: stamp a per-actor {@link TrustVerdict} onto inbound
 * `sourceMetadata` from the local contact store, so the daemon's ACL stage
 * (which now reads the verdict and fail-closed-denies when it is absent) sees
 * the same verdict the gateway would resolve in production.
 *
 * Skipped when a test already supplies `trustVerdict` (or sets `sourceMetadata`
 * to null) so absent-verdict / explicit-verdict tests keep their setup.
 */
function stampTrustVerdict(body: Record<string, unknown>): void {
  const meta = body.sourceMetadata as Record<string, unknown> | undefined;
  if (meta && "trustVerdict" in meta) return;

  const channelType = String(body.sourceChannel ?? "");
  const actorExternalId =
    typeof body.actorExternalId === "string" ? body.actorExternalId : undefined;
  if (!channelType) return;

  const verdict = resolveLocalTrustVerdict({
    channelType,
    actorExternalId,
  });
  body.sourceMetadata = { ...(meta ?? {}), trustVerdict: verdict };
}

/** Local mirror of the gateway resolver, reading the daemon contact store. */
export function resolveLocalTrustVerdict(input: {
  channelType: string;
  actorExternalId?: string;
}): TrustVerdict {
  const canonicalSenderId = input.actorExternalId ?? null;

  // Match the gateway's address-only member resolution (no externalChatId).
  const member = input.actorExternalId
    ? findContactChannel({
        channelType: input.channelType,
        address: input.actorExternalId,
      })
    : null;
  const guardian = deriveGuardianForChannel(input.channelType);

  const isGuardian =
    !!guardian &&
    !!canonicalSenderId &&
    guardian.address.toLowerCase() === canonicalSenderId.toLowerCase();

  // Mirror the gateway: read the member ACL from the warmed verdict cache (the
  // source production resolves from) rather than the local ACL columns.
  const memberAcl =
    member && input.actorExternalId && isChannelId(input.channelType)
      ? getCachedMemberAcl(input.channelType, input.actorExternalId)
      : undefined;

  let trustClass: TrustClass;
  if (isGuardian) {
    trustClass = "guardian";
  } else if (memberAcl) {
    const status = memberAcl.status;
    if (status === "active") trustClass = "trusted_contact";
    else if (status === "unverified" || status === "pending")
      trustClass = "unverified_contact";
    else trustClass = "unknown";
  } else {
    trustClass = "unknown";
  }

  const verdict: TrustVerdict = { trustClass, canonicalSenderId };

  if (guardian) {
    verdict.guardianExternalUserId = guardian.address;
    verdict.guardianDeliveryChatId = guardian.externalChatId ?? null;
    if (guardian.principalId)
      verdict.guardianPrincipalId = guardian.principalId;
    verdict.guardianDisplayName = guardian.displayName ?? undefined;
  }

  if (member && memberAcl) {
    verdict.contactId = member.channel.contactId;
    verdict.channelId = member.channel.id;
    verdict.type = member.channel.type;
    verdict.address = member.channel.address;
    verdict.externalChatId = member.channel.externalChatId;
    verdict.status = memberAcl.status;
    verdict.policy = memberAcl.policy;
    verdict.memberDisplayName = member.contact.displayName;
  }

  return verdict;
}

export { seedContactChannel } from "./seed-contact-channel.js";

// ---------------------------------------------------------------------------
// handleDeleteConversation adapter
// ---------------------------------------------------------------------------

export async function handleDeleteConversation(
  req: Request,
  _assistantId?: string,
): Promise<Response> {
  const body = await req.json();
  return wrapHandler(() => _handleDeleteConversation({ body }));
}

// ---------------------------------------------------------------------------
// handleChannelDeliveryAck adapter
// ---------------------------------------------------------------------------

export async function handleChannelDeliveryAck(
  req: Request,
): Promise<Response> {
  const body = await req.json();
  return wrapHandler(() => _handleChannelDeliveryAck({ body }));
}

// ---------------------------------------------------------------------------
// handleListDeadLetters adapter
// ---------------------------------------------------------------------------

export function handleListDeadLetters(): Response {
  const result = _handleListDeadLetters();
  return Response.json(result);
}

// ---------------------------------------------------------------------------
// handleReplayDeadLetters adapter
// ---------------------------------------------------------------------------

export async function handleReplayDeadLetters(req: Request): Promise<Response> {
  const body = await req.json();
  return wrapHandler(() => _handleReplayDeadLetters({ body }));
}
