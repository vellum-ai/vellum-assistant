/**
 * A2A pairing protocol implementation.
 *
 * Implements the five-phase invite-code-gated pairing handshake with
 * 6-digit verification ceremony:
 *   1. Initiator sends PairingRequest (unauthenticated)
 *   2. Target's guardian approves → mints verification code
 *   2b. Guardians exchange code out-of-band
 *   2c. Initiator sends PairingVerify with code (unauthenticated)
 *   3. Target validates code → sends PairingAccepted (unauthenticated)
 *   4. Initiator validates + sends PairingFinalize (authenticated)
 *   5. Target stores outbound token → mutual auth complete
 *
 * Each phase stores state in the a2a_pairing_requests table and manages
 * inbound/outbound tokens in the secure key store.
 */

import { randomBytes } from "node:crypto";

import {
  upsertAssistantContactMetadata,
  upsertContact,
} from "../../contacts/contact-store.js";
import {
  getSecureKeyAsync,
  setSecureKeyAsync,
} from "../../security/secure-keys.js";
import { getLogger } from "../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { validateAndConsumeVerification } from "../channel-verification-service.js";
import type {
  A2APairingAccepted,
  A2APairingFinalize,
  A2APairingRequest,
  A2APairingVerify,
} from "./message-contract.js";
import {
  createPairingRequest,
  findPairingByInviteCode,
  findPairingByRemoteAssistant,
  findPendingOutboundPairing,
  PAIRING_REQUEST_TTL_MS,
  updatePairingStatus,
} from "./pairing-store.js";

const log = getLogger("a2a-pairing");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a cryptographically random invite code (24 bytes, base64url). */
function generateInviteCode(): string {
  return randomBytes(24).toString("base64url");
}

/** Generate a cryptographically random token for bearer auth. */
function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Create an active assistant contact with metadata.
 * Uses the direct upsertContact path (same pattern as phone/voice
 * direct-activation in guardian-request-resolvers.ts).
 */
function createAssistantContact(
  remoteAssistantId: string,
  remoteGatewayUrl: string,
): void {
  const result = upsertContact({
    displayName: remoteAssistantId,
    contactType: "assistant",
    channels: [
      {
        type: "vellum",
        address: remoteAssistantId,
        externalUserId: remoteAssistantId,
        externalChatId: remoteAssistantId,
        status: "active",
        policy: "allow",
      },
    ],
  });

  upsertAssistantContactMetadata({
    contactId: result.id,
    species: "vellum",
    metadata: {
      assistantId: remoteAssistantId,
      gatewayUrl: remoteGatewayUrl,
    },
  });
}

// ---------------------------------------------------------------------------
// Phase 1: Initiator sends pairing request
// ---------------------------------------------------------------------------

export interface InitiatePairingResult {
  inviteCode: string;
  pairingRequestId: string;
}

/**
 * Initiate pairing with a remote assistant.
 *
 * Generates an invite code, stores an outbound pairing request, and sends
 * the pairing request to the target's gateway (unauthenticated).
 */
export async function initiatePairing(
  targetAssistantId: string,
  targetGatewayUrl: string,
  localAssistantId: string = DAEMON_INTERNAL_ASSISTANT_ID,
  localGatewayUrl?: string,
): Promise<InitiatePairingResult> {
  const inviteCode = generateInviteCode();
  const expiresAt = Date.now() + PAIRING_REQUEST_TTL_MS;

  const pairingRequest = createPairingRequest(
    "outbound",
    inviteCode,
    targetAssistantId,
    targetGatewayUrl,
    expiresAt,
  );

  // Send pairing request to target (unauthenticated)
  const envelope: A2APairingRequest = {
    version: "v1",
    type: "pairing_request",
    senderAssistantId: localAssistantId,
    senderGatewayUrl: localGatewayUrl ?? "",
    inviteCode,
  };

  try {
    const url = `${targetGatewayUrl}/webhook/a2a`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });

    if (!response.ok) {
      log.warn(
        {
          event: "a2a_pairing_request_delivery_failed",
          targetAssistantId,
          targetGatewayUrl,
          status: response.status,
        },
        "Failed to deliver A2A pairing request",
      );
    }
  } catch (err) {
    log.error(
      { err, targetAssistantId, targetGatewayUrl },
      "Error sending A2A pairing request",
    );
  }

  log.info(
    {
      event: "a2a_pairing_initiated",
      pairingRequestId: pairingRequest.id,
      targetAssistantId,
    },
    "A2A pairing initiated",
  );

  return {
    inviteCode,
    pairingRequestId: pairingRequest.id,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: Target receives pairing request
// ---------------------------------------------------------------------------

/**
 * Handle an incoming A2A pairing request on the target side.
 *
 * Stores the inbound pairing request. The actual guardian notification
 * is handled by the A2A interceptor which calls notifyGuardianOfAccessRequest.
 */
export function handleInboundPairingRequest(envelope: A2APairingRequest): void {
  const expiresAt = Date.now() + PAIRING_REQUEST_TTL_MS;

  createPairingRequest(
    "inbound",
    envelope.inviteCode,
    envelope.senderAssistantId,
    envelope.senderGatewayUrl,
    expiresAt,
  );

  log.info(
    {
      event: "a2a_pairing_request_received",
      senderAssistantId: envelope.senderAssistantId,
      senderGatewayUrl: envelope.senderGatewayUrl,
    },
    "A2A pairing request received and stored",
  );
}

// ---------------------------------------------------------------------------
// Phase 2b: Target's guardian approves → transition to verification_pending
// ---------------------------------------------------------------------------

/**
 * Transition the target side of pairing to verification_pending after
 * guardian approval.
 *
 * Does NOT create contacts, generate tokens, or send pairing_accepted.
 * Those happen in completePairingVerification() after the 6-digit code
 * is verified by the initiator's guardian. This mirrors the text-channel
 * verification ceremony used for human trusted contacts.
 *
 * Returns true if the pairing was found and transitioned successfully.
 */
export function completePairingApproval(remoteAssistantId: string): boolean {
  const pairingRequest = findPairingByRemoteAssistant(
    remoteAssistantId,
    "inbound",
  );

  if (!pairingRequest || pairingRequest.status !== "pending") {
    log.warn(
      {
        event: "a2a_pairing_approval_no_request",
        remoteAssistantId,
      },
      "No pending inbound pairing request found for approval",
    );
    return false;
  }

  updatePairingStatus(pairingRequest.id, "verification_pending");

  log.info(
    {
      event: "a2a_pairing_verification_pending",
      pairingRequestId: pairingRequest.id,
      remoteAssistantId,
    },
    "A2A pairing approved by guardian — awaiting verification code exchange",
  );

  return true;
}

// ---------------------------------------------------------------------------
// Phase 2c: Verification code confirmed → complete token exchange
// ---------------------------------------------------------------------------

/**
 * Complete the target side of pairing after verification code confirmation.
 *
 * Creates the contact, generates an inbound token, stores gateway URL,
 * and sends PairingAccepted back to the initiator. This is only called
 * after the 6-digit verification code has been confirmed by the
 * initiator's guardian via `assistant contacts pair-verify`.
 *
 * Returns true if successful, false if the pairing request was not found
 * or could not be processed.
 */
export async function completePairingVerification(
  remoteAssistantId: string,
  localAssistantId: string = DAEMON_INTERNAL_ASSISTANT_ID,
): Promise<boolean> {
  const pairingRequest = findPairingByRemoteAssistant(
    remoteAssistantId,
    "inbound",
  );

  if (!pairingRequest || pairingRequest.status !== "verification_pending") {
    log.warn(
      {
        event: "a2a_pairing_verification_no_request",
        remoteAssistantId,
      },
      "No verification_pending inbound pairing request found",
    );
    return false;
  }

  const remoteGatewayUrl = pairingRequest.remoteGatewayUrl;

  // Create contact with assistant metadata
  createAssistantContact(remoteAssistantId, remoteGatewayUrl);

  // Generate and store inbound token (token the remote assistant uses to contact us)
  const inboundToken = generateToken();
  await setSecureKeyAsync(`a2a:inbound:${remoteAssistantId}`, inboundToken);

  // Store gateway URL for delivery routing
  await setSecureKeyAsync(`a2a:gateway:${remoteAssistantId}`, remoteGatewayUrl);

  // Send PairingAccepted back to initiator (unauthenticated — validated via invite code)
  const envelope: A2APairingAccepted = {
    version: "v1",
    type: "pairing_accepted",
    senderAssistantId: localAssistantId,
    inviteCode: pairingRequest.inviteCode,
    inboundToken,
  };

  try {
    const url = `${remoteGatewayUrl}/webhook/a2a`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });

    if (!response.ok) {
      log.warn(
        {
          event: "a2a_pairing_accepted_delivery_failed",
          remoteAssistantId,
          status: response.status,
        },
        "Failed to deliver A2A pairing accepted",
      );
      updatePairingStatus(pairingRequest.id, "failed");
      return false;
    }
  } catch (err) {
    log.error({ err, remoteAssistantId }, "Error sending A2A pairing accepted");
    updatePairingStatus(pairingRequest.id, "failed");
    return false;
  }

  updatePairingStatus(pairingRequest.id, "accepted");

  log.info(
    {
      event: "a2a_pairing_verified_and_accepted",
      pairingRequestId: pairingRequest.id,
      remoteAssistantId,
    },
    "A2A pairing verification complete — acceptance sent",
  );

  return true;
}

// ---------------------------------------------------------------------------
// Phase 2d: Initiator sends verification code to target
// ---------------------------------------------------------------------------

/**
 * Send the verification code to the target assistant.
 *
 * Called by the initiator's guardian via `assistant contacts pair-verify`.
 * Looks up the pending outbound pairing request and sends a PairingVerify
 * envelope to the target's gateway (unauthenticated, bound by invite code).
 */
export async function sendPairingVerify(
  verificationCode: string,
  localAssistantId: string = DAEMON_INTERNAL_ASSISTANT_ID,
): Promise<{ ok: boolean; error?: string }> {
  const pairingRequest = findPendingOutboundPairing();

  if (!pairingRequest) {
    return {
      ok: false,
      error:
        "No pending outbound pairing request found. Start pairing first with `assistant contacts pair`.",
    };
  }

  const envelope: A2APairingVerify = {
    version: "v1",
    type: "pairing_verify",
    senderAssistantId: localAssistantId,
    inviteCode: pairingRequest.inviteCode,
    verificationCode,
  };

  try {
    const url = `${pairingRequest.remoteGatewayUrl}/webhook/a2a`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });

    if (!response.ok) {
      log.warn(
        {
          event: "a2a_pairing_verify_delivery_failed",
          remoteAssistantId: pairingRequest.remoteAssistantId,
          status: response.status,
        },
        "Failed to deliver A2A pairing verify",
      );
      return {
        ok: false,
        error: "Failed to deliver verification code to the remote assistant.",
      };
    }
  } catch (err) {
    log.error(
      { err, remoteAssistantId: pairingRequest.remoteAssistantId },
      "Error sending A2A pairing verify",
    );
    return { ok: false, error: "Error connecting to the remote assistant." };
  }

  log.info(
    {
      event: "a2a_pairing_verify_sent",
      remoteAssistantId: pairingRequest.remoteAssistantId,
    },
    "A2A pairing verification code sent",
  );

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Phase 2e: Target receives and validates verification code
// ---------------------------------------------------------------------------

/**
 * Handle an incoming PairingVerify envelope on the target side.
 *
 * Validates the invite code binding, then validates the verification code
 * against the pending verification session. If valid, triggers the full
 * token exchange via completePairingVerification().
 */
export async function handlePairingVerify(
  envelope: A2APairingVerify,
  localAssistantId: string = DAEMON_INTERNAL_ASSISTANT_ID,
): Promise<{ verified: boolean; error?: string }> {
  // Look up the inbound pairing request by invite code
  const pairingRequest = findPairingByInviteCode(envelope.inviteCode);

  if (!pairingRequest) {
    log.warn(
      {
        event: "a2a_pairing_verify_no_request",
        inviteCode: envelope.inviteCode.slice(0, 8) + "...",
      },
      "Received pairing_verify with no matching inbound request",
    );
    return { verified: false, error: "No matching pairing request found." };
  }

  if (
    pairingRequest.direction !== "inbound" ||
    pairingRequest.status !== "verification_pending"
  ) {
    log.warn(
      {
        event: "a2a_pairing_verify_invalid_state",
        direction: pairingRequest.direction,
        status: pairingRequest.status,
      },
      "Pairing request in wrong state for pairing_verify",
    );
    return {
      verified: false,
      error: "Pairing request not in verification pending state.",
    };
  }

  // Validate sender identity matches stored remote assistant
  if (envelope.senderAssistantId !== pairingRequest.remoteAssistantId) {
    log.warn(
      {
        event: "a2a_pairing_verify_identity_mismatch",
        expected: pairingRequest.remoteAssistantId,
        received: envelope.senderAssistantId,
      },
      "Pairing verify sender identity mismatch",
    );
    return { verified: false, error: "Sender identity mismatch." };
  }

  // Validate the verification code against the pending session
  const result = validateAndConsumeVerification(
    "vellum",
    envelope.verificationCode,
    envelope.senderAssistantId,
    envelope.senderAssistantId,
  );

  if (!result.success) {
    log.warn(
      {
        event: "a2a_pairing_verify_code_invalid",
        remoteAssistantId: envelope.senderAssistantId,
      },
      "A2A pairing verification code invalid or expired",
    );
    return {
      verified: false,
      error: "The verification code is invalid or has expired.",
    };
  }

  // Verification succeeded — complete the token exchange
  const success = await completePairingVerification(
    envelope.senderAssistantId,
    localAssistantId,
  );

  if (!success) {
    return {
      verified: false,
      error: "Failed to complete pairing after verification.",
    };
  }

  log.info(
    {
      event: "a2a_pairing_verify_success",
      remoteAssistantId: envelope.senderAssistantId,
    },
    "A2A pairing verification succeeded — token exchange initiated",
  );

  return { verified: true };
}

// ---------------------------------------------------------------------------
// Phase 3: Initiator receives PairingAccepted
// ---------------------------------------------------------------------------

/**
 * Handle an incoming PairingAccepted envelope on the initiator side.
 *
 * Validates the invite code and sender identity, stores the outbound token,
 * generates an inbound token, creates the contact, and sends PairingFinalize.
 */
export async function handlePairingAccepted(
  envelope: A2APairingAccepted,
  localAssistantId: string = DAEMON_INTERNAL_ASSISTANT_ID,
): Promise<boolean> {
  // Look up the outbound pairing request by invite code
  const pairingRequest = findPairingByInviteCode(envelope.inviteCode);

  if (!pairingRequest) {
    log.warn(
      {
        event: "a2a_pairing_accepted_no_request",
        inviteCode: envelope.inviteCode.slice(0, 8) + "...",
      },
      "Received pairing_accepted with no matching outbound request (not found or expired)",
    );
    return false;
  }

  if (
    pairingRequest.direction !== "outbound" ||
    pairingRequest.status !== "pending"
  ) {
    log.warn(
      {
        event: "a2a_pairing_accepted_invalid_state",
        direction: pairingRequest.direction,
        status: pairingRequest.status,
      },
      "Pairing request in wrong state for pairing_accepted",
    );
    return false;
  }

  // Validate sender identity matches stored remote assistant
  if (envelope.senderAssistantId !== pairingRequest.remoteAssistantId) {
    log.warn(
      {
        event: "a2a_pairing_accepted_identity_mismatch",
        expected: pairingRequest.remoteAssistantId,
        received: envelope.senderAssistantId,
      },
      "Pairing accepted sender identity mismatch — possible impersonation",
    );
    return false;
  }

  const remoteGatewayUrl = pairingRequest.remoteGatewayUrl;

  // Store the received token as our outbound token (to contact them)
  await setSecureKeyAsync(
    `a2a:outbound:${envelope.senderAssistantId}`,
    envelope.inboundToken,
  );

  // Generate our inbound token (for them to contact us)
  const inboundToken = generateToken();
  await setSecureKeyAsync(
    `a2a:inbound:${envelope.senderAssistantId}`,
    inboundToken,
  );

  // Store gateway URL from the STORED pairing request (not from the envelope)
  await setSecureKeyAsync(
    `a2a:gateway:${envelope.senderAssistantId}`,
    remoteGatewayUrl,
  );

  // Create reciprocal contact
  createAssistantContact(envelope.senderAssistantId, remoteGatewayUrl);

  // Send PairingFinalize (authenticated — we now have the outbound token)
  const finalizeEnvelope: A2APairingFinalize = {
    version: "v1",
    type: "pairing_finalize",
    senderAssistantId: localAssistantId,
    inviteCode: envelope.inviteCode,
    inboundToken,
  };

  try {
    const url = `${remoteGatewayUrl}/deliver/a2a`;
    const outboundToken = await getSecureKeyAsync(
      `a2a:outbound:${envelope.senderAssistantId}`,
    );

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${outboundToken}`,
      },
      body: JSON.stringify(finalizeEnvelope),
    });

    if (!response.ok) {
      log.warn(
        {
          event: "a2a_pairing_finalize_delivery_failed",
          remoteAssistantId: envelope.senderAssistantId,
          status: response.status,
        },
        "Failed to deliver A2A pairing finalize",
      );
    }
  } catch (err) {
    log.error(
      { err, remoteAssistantId: envelope.senderAssistantId },
      "Error sending A2A pairing finalize",
    );
  }

  updatePairingStatus(pairingRequest.id, "accepted");

  log.info(
    {
      event: "a2a_pairing_accepted_processed",
      pairingRequestId: pairingRequest.id,
      remoteAssistantId: envelope.senderAssistantId,
    },
    "A2A pairing accepted processed — finalize sent",
  );

  return true;
}

// ---------------------------------------------------------------------------
// Phase 4: Target receives PairingFinalize
// ---------------------------------------------------------------------------

/**
 * Handle an incoming PairingFinalize envelope on the target side.
 *
 * This arrives authenticated (gateway verified Bearer token). Validates
 * the invite code and sender identity, then stores the outbound token.
 */
export async function handlePairingFinalize(
  envelope: A2APairingFinalize,
): Promise<boolean> {
  // Look up the inbound pairing request by invite code
  const pairingRequest = findPairingByInviteCode(envelope.inviteCode);

  if (!pairingRequest) {
    log.warn(
      {
        event: "a2a_pairing_finalize_no_request",
        inviteCode: envelope.inviteCode.slice(0, 8) + "...",
      },
      "Received pairing_finalize with no matching inbound request",
    );
    return false;
  }

  if (
    pairingRequest.direction !== "inbound" ||
    pairingRequest.status !== "accepted"
  ) {
    log.warn(
      {
        event: "a2a_pairing_finalize_invalid_state",
        direction: pairingRequest.direction,
        status: pairingRequest.status,
      },
      "Pairing request in wrong state for pairing_finalize",
    );
    return false;
  }

  // Validate sender identity matches stored remote assistant
  if (envelope.senderAssistantId !== pairingRequest.remoteAssistantId) {
    log.warn(
      {
        event: "a2a_pairing_finalize_identity_mismatch",
        expected: pairingRequest.remoteAssistantId,
        received: envelope.senderAssistantId,
      },
      "Pairing finalize sender identity mismatch",
    );
    return false;
  }

  // Store the received token as our outbound token (to contact them)
  await setSecureKeyAsync(
    `a2a:outbound:${envelope.senderAssistantId}`,
    envelope.inboundToken,
  );

  log.info(
    {
      event: "a2a_pairing_finalize_complete",
      pairingRequestId: pairingRequest.id,
      remoteAssistantId: envelope.senderAssistantId,
    },
    "A2A pairing finalize complete — mutual auth established",
  );

  return true;
}
