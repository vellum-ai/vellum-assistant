/**
 * A2A interceptor — routes A2A pairing envelopes before normal inbound
 * processing (before ACL enforcement, conversation routing, etc.).
 *
 * Checks `sourceMetadata?.a2a === true` on the inbound payload and routes
 * by `sourceMetadata.envelopeType`:
 *   - "pairing_request"  → handlePairingRequest()
 *   - "pairing_accepted" → handlePairingAccepted()
 *   - "pairing_finalize" → handlePairingFinalize()
 *   - "message"          → pass through to normal inbound pipeline
 *
 * Safety invariant: unauthenticated envelopes can only reach pairing
 * handlers (pairing_request, pairing_accepted), never the message pipeline.
 */

import { notifyGuardianOfAccessRequest } from "../../access-request-helper.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../assistant-scope.js";
import {
  handlePairingAccepted,
  handlePairingFinalize,
  handleInboundPairingRequest,
} from "../../a2a/pairing.js";
import { parseA2AEnvelope } from "../../a2a/message-contract.js";
import { getLogger } from "../../../util/logger.js";

const log = getLogger("a2a-interceptor");

export interface A2AInterceptResult {
  /** Whether the interceptor consumed the request. */
  handled: boolean;
  /** HTTP response to return when handled. */
  response?: Response;
}

interface A2ASourceMetadata {
  a2a: true;
  envelopeType: string;
  authenticated: boolean;
  senderAssistantId?: string;
  senderGatewayUrl?: string;
  envelope?: unknown;
}

function isA2ASourceMetadata(
  metadata: Record<string, unknown> | undefined,
): metadata is A2ASourceMetadata {
  return metadata != null && metadata.a2a === true;
}

/**
 * Intercept A2A envelopes before normal inbound message processing.
 *
 * Returns `{ handled: true, response }` when the envelope was consumed
 * by a pairing handler. Returns `{ handled: false }` to let normal
 * inbound processing continue (for "message" type envelopes).
 */
export async function interceptA2AEnvelope(params: {
  sourceMetadata?: Record<string, unknown>;
  canonicalAssistantId?: string;
}): Promise<A2AInterceptResult> {
  const { sourceMetadata, canonicalAssistantId } = params;

  if (!isA2ASourceMetadata(sourceMetadata)) {
    return { handled: false };
  }

  const { envelopeType, authenticated, envelope: rawEnvelope } = sourceMetadata;

  // Safety invariant: unauthenticated envelopes can only reach pairing
  // handlers, never the message processing pipeline.
  if (
    !authenticated &&
    envelopeType !== "pairing_request" &&
    envelopeType !== "pairing_accepted"
  ) {
    log.warn(
      {
        event: "a2a_interceptor_unauthenticated_rejected",
        envelopeType,
      },
      "Rejected unauthenticated A2A envelope — only pairing_request and pairing_accepted allowed",
    );
    return {
      handled: true,
      response: Response.json(
        {
          error:
            "Unauthenticated A2A envelopes can only reach pairing handlers",
        },
        { status: 403 },
      ),
    };
  }

  switch (envelopeType) {
    case "pairing_request":
      return handlePairingRequestIntercept(rawEnvelope, canonicalAssistantId);

    case "pairing_accepted":
      return handlePairingAcceptedIntercept(rawEnvelope);

    case "pairing_finalize":
      return handlePairingFinalizeIntercept(rawEnvelope);

    case "message":
      // Pass through to normal inbound pipeline
      return { handled: false };

    default:
      log.warn(
        { event: "a2a_interceptor_unknown_type", envelopeType },
        "Unknown A2A envelope type",
      );
      return {
        handled: true,
        response: Response.json(
          { error: `Unknown A2A envelope type: ${envelopeType}` },
          { status: 400 },
        ),
      };
  }
}

// ---------------------------------------------------------------------------
// Pairing request handler
// ---------------------------------------------------------------------------

async function handlePairingRequestIntercept(
  rawEnvelope: unknown,
  canonicalAssistantId: string = DAEMON_INTERNAL_ASSISTANT_ID,
): Promise<A2AInterceptResult> {
  try {
    const envelope = parseA2AEnvelope(rawEnvelope);
    if (envelope.type !== "pairing_request") {
      return {
        handled: true,
        response: Response.json(
          { error: "Expected pairing_request" },
          { status: 400 },
        ),
      };
    }

    // Store the inbound pairing request
    handleInboundPairingRequest(envelope);

    // Trigger guardian notification via the existing access request flow.
    // The guardian will see "Assistant [X] wants to pair with your assistant."
    notifyGuardianOfAccessRequest({
      canonicalAssistantId,
      sourceChannel: "vellum",
      conversationExternalId: `a2a-pairing:${envelope.senderAssistantId}`,
      actorExternalId: envelope.senderAssistantId,
      actorDisplayName: `Assistant ${envelope.senderAssistantId}`,
      messagePreview: `Assistant ${envelope.senderAssistantId} (at ${envelope.senderGatewayUrl}) wants to pair with your assistant.`,
    });

    log.info(
      {
        event: "a2a_pairing_request_intercepted",
        senderAssistantId: envelope.senderAssistantId,
      },
      "A2A pairing request intercepted — guardian notified",
    );

    return {
      handled: true,
      response: Response.json({ accepted: true, type: "pairing_request" }),
    };
  } catch (err) {
    log.error({ err }, "Error handling A2A pairing request");
    return {
      handled: true,
      response: Response.json(
        { error: "Failed to process pairing request" },
        { status: 500 },
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// Pairing accepted handler
// ---------------------------------------------------------------------------

async function handlePairingAcceptedIntercept(
  rawEnvelope: unknown,
): Promise<A2AInterceptResult> {
  try {
    const envelope = parseA2AEnvelope(rawEnvelope);
    if (envelope.type !== "pairing_accepted") {
      return {
        handled: true,
        response: Response.json(
          { error: "Expected pairing_accepted" },
          { status: 400 },
        ),
      };
    }

    const success = await handlePairingAccepted(envelope);

    return {
      handled: true,
      response: Response.json({
        accepted: success,
        type: "pairing_accepted",
      }),
    };
  } catch (err) {
    log.error({ err }, "Error handling A2A pairing accepted");
    return {
      handled: true,
      response: Response.json(
        { error: "Failed to process pairing accepted" },
        { status: 500 },
      ),
    };
  }
}

// ---------------------------------------------------------------------------
// Pairing finalize handler
// ---------------------------------------------------------------------------

async function handlePairingFinalizeIntercept(
  rawEnvelope: unknown,
): Promise<A2AInterceptResult> {
  try {
    const envelope = parseA2AEnvelope(rawEnvelope);
    if (envelope.type !== "pairing_finalize") {
      return {
        handled: true,
        response: Response.json(
          { error: "Expected pairing_finalize" },
          { status: 400 },
        ),
      };
    }

    const success = await handlePairingFinalize(envelope);

    return {
      handled: true,
      response: Response.json({
        accepted: success,
        type: "pairing_finalize",
      }),
    };
  } catch (err) {
    log.error({ err }, "Error handling A2A pairing finalize");
    return {
      handled: true,
      response: Response.json(
        { error: "Failed to process pairing finalize" },
        { status: 500 },
      ),
    };
  }
}
