/**
 * Route handlers for A2A integration config endpoints.
 *
 * GET    /v1/integrations/a2a/config          — get current A2A config status
 * POST   /v1/integrations/a2a/config          — enable A2A channel
 * DELETE /v1/integrations/a2a/config          — disable A2A channel
 * POST   /v1/integrations/a2a/invite          — create a shareable A2A invite token
 * POST   /v1/integrations/a2a/invite/complete — sender-side invite completion
 * POST   /v1/integrations/a2a/invite/redeem   — receiver-side invite redemption
 */

import { isA2AEnabled } from "../../../a2a/feature-gate.js";
import { getConfig } from "../../../config/loader.js";
import {
  clearA2AConfig,
  completeA2AInvite,
  createA2AInvite,
  getA2AConfig,
  redeemA2AInvite,
  setA2AConfig,
} from "../../../daemon/handlers/config-a2a.js";
import { BadRequestError } from "../errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertA2AFlag(): void {
  if (!isA2AEnabled(getConfig())) {
    throw new BadRequestError("A2A channel is not available");
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleGetA2AConfig() {
  assertA2AFlag();
  return getA2AConfig();
}

function handleSetA2AConfig() {
  assertA2AFlag();
  const result = setA2AConfig();
  if (!result.success) {
    throw new BadRequestError(result.error ?? "Failed to enable A2A");
  }
  return result;
}

function handleClearA2AConfig() {
  assertA2AFlag();
  return clearA2AConfig();
}

function handleCreateA2AInvite({ body = {} }: RouteHandlerArgs) {
  assertA2AFlag();
  const { expiresInHours } = body as { expiresInHours?: number };
  const result = createA2AInvite({ expiresInHours });
  if (!result.success) {
    throw new BadRequestError(result.error ?? "Failed to create A2A invite");
  }
  return result;
}

function handleCompleteA2AInvite({ body = {} }: RouteHandlerArgs) {
  const { token, acceptor } = body as {
    token?: unknown;
    acceptor?: {
      assistantId?: unknown;
      displayName?: unknown;
      gatewayUrl?: unknown;
    };
  };

  if (typeof token !== "string" || !token) {
    throw new BadRequestError(
      "token is required and must be a non-empty string",
    );
  }
  if (
    !acceptor ||
    typeof acceptor.assistantId !== "string" ||
    !acceptor.assistantId ||
    typeof acceptor.displayName !== "string" ||
    !acceptor.displayName ||
    typeof acceptor.gatewayUrl !== "string" ||
    !acceptor.gatewayUrl
  ) {
    throw new BadRequestError(
      "acceptor must include non-empty assistantId, displayName, and gatewayUrl",
    );
  }

  const result = completeA2AInvite({
    token,
    acceptor: {
      assistantId: acceptor.assistantId,
      displayName: acceptor.displayName,
      gatewayUrl: acceptor.gatewayUrl,
    },
  });
  if (!result.success) {
    throw new BadRequestError(result.error ?? "Failed to complete A2A invite");
  }
  return result;
}

function handleRedeemA2AInvite({ body = {} }: RouteHandlerArgs) {
  const { sender } = body as {
    sender?: {
      assistantId?: unknown;
      displayName?: unknown;
      gatewayUrl?: unknown;
    };
  };

  if (
    !sender ||
    typeof sender.assistantId !== "string" ||
    !sender.assistantId ||
    typeof sender.displayName !== "string" ||
    !sender.displayName ||
    typeof sender.gatewayUrl !== "string" ||
    !sender.gatewayUrl
  ) {
    throw new BadRequestError(
      "sender must include non-empty assistantId, displayName, and gatewayUrl",
    );
  }

  const result = redeemA2AInvite({
    sender: {
      assistantId: sender.assistantId,
      displayName: sender.displayName,
      gatewayUrl: sender.gatewayUrl,
    },
  });
  if (!result.success) {
    throw new BadRequestError(result.error ?? "Failed to redeem A2A invite");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "integrations_a2a_config_get",
    endpoint: "integrations/a2a/config",
    method: "GET",
    summary: "Get A2A config",
    description: "Check current A2A channel configuration status.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: () => handleGetA2AConfig(),
  },
  {
    operationId: "integrations_a2a_config_post",
    endpoint: "integrations/a2a/config",
    method: "POST",
    summary: "Enable A2A channel",
    description: "Enable the A2A channel for inter-assistant communication.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: () => handleSetA2AConfig(),
  },
  {
    operationId: "integrations_a2a_config_delete",
    endpoint: "integrations/a2a/config",
    method: "DELETE",
    summary: "Disable A2A channel",
    description: "Disable the A2A channel.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: () => handleClearA2AConfig(),
  },
  {
    operationId: "integrations_a2a_invite_post",
    endpoint: "integrations/a2a/invite",
    method: "POST",
    summary: "Create A2A invite",
    description:
      "Create a shareable A2A invite token for link-based contact creation.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: handleCreateA2AInvite,
  },
  {
    operationId: "integrations_a2a_invite_complete_post",
    endpoint: "integrations/a2a/invite/complete",
    method: "POST",
    summary: "Complete A2A invite (sender side)",
    description:
      "Called by the platform to finalize the sender side of a link-based A2A connection.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: handleCompleteA2AInvite,
  },
  {
    operationId: "integrations_a2a_invite_redeem_post",
    endpoint: "integrations/a2a/invite/redeem",
    method: "POST",
    summary: "Redeem A2A invite (receiver side)",
    description:
      "Called by the platform to create a trusted contact on the receiver side of a link-based A2A connection.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: handleRedeemA2AInvite,
  },
];
