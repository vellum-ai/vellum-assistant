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

import type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
  GuardianActionCopyGenerator,
  GuardianFollowUpConversationGenerator,
  MessageProcessor,
} from "../../runtime/http-types.js";
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
  _guardianActionCopyGenerator?: GuardianActionCopyGenerator,
  _guardianFollowUpConversationGenerator?: GuardianFollowUpConversationGenerator,
): Promise<Response> {
  const body = await req.json();
  return wrapHandler(() => _handleChannelInbound({ body }));
}

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
