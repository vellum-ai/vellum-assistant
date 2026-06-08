/**
 * Route handlers for A2A integration config endpoints.
 *
 * GET    /v1/integrations/a2a/config          — get current A2A config status
 * POST   /v1/integrations/a2a/config          — enable A2A channel
 * DELETE /v1/integrations/a2a/config          — disable A2A channel
 * POST   /v1/integrations/a2a/invite          — create a shareable A2A invite token
 * POST   /v1/integrations/a2a/invite/complete — sender-side invite completion
 * POST   /v1/integrations/a2a/invite/redeem   — receiver-side invite redemption
 * POST   /v1/integrations/a2a/invite/accept   — self-hosted broker: orchestrate complete + redeem
 */

import { isA2AEnabled } from "../../../a2a/feature-gate.js";
import { getConfig } from "../../../config/loader.js";
import {
  A2AConfigResultSchema,
  acceptA2AInvite,
  AcceptA2AInviteResultSchema,
  clearA2AConfig,
  completeA2AInvite,
  CompleteA2AInviteResultSchema,
  createA2AInvite,
  CreateA2AInviteResultSchema,
  getA2AConfig,
  redeemA2AInvite,
  RedeemA2AInviteResultSchema,
  setA2AConfig,
} from "../../../daemon/handlers/config-a2a.js";
import {
  ACTOR_PRINCIPALS,
  GATEWAY_PRINCIPALS,
} from "../../auth/route-policy.js";
import { BadGatewayError, BadRequestError } from "../errors.js";
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
  const { expiresInHours } = body as { expiresInHours?: unknown };
  if (expiresInHours !== undefined) {
    if (
      typeof expiresInHours !== "number" ||
      !Number.isFinite(expiresInHours) ||
      expiresInHours <= 0
    ) {
      throw new BadRequestError(
        "expiresInHours must be a positive finite number",
      );
    }
  }
  const result = createA2AInvite({
    expiresInHours: expiresInHours as number | undefined,
  });
  if (!result.success) {
    throw new BadRequestError(result.error ?? "Failed to create A2A invite");
  }
  return result;
}

function handleCompleteA2AInvite({ body = {} }: RouteHandlerArgs) {
  const { token, senderAssistantId, acceptor } = body as {
    token?: unknown;
    senderAssistantId?: unknown;
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
  if (typeof senderAssistantId !== "string" || !senderAssistantId) {
    throw new BadRequestError(
      "senderAssistantId is required and must be a non-empty string",
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
    senderAssistantId,
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

async function handleAcceptA2AInvite({ body = {} }: RouteHandlerArgs) {
  assertA2AFlag();
  const { senderGatewayUrl, senderAssistantId, token } = body as {
    senderGatewayUrl?: unknown;
    senderAssistantId?: unknown;
    token?: unknown;
  };

  if (typeof senderGatewayUrl !== "string" || !senderGatewayUrl) {
    throw new BadRequestError(
      "senderGatewayUrl is required and must be a non-empty string",
    );
  }
  try {
    new URL(senderGatewayUrl);
  } catch {
    throw new BadRequestError("senderGatewayUrl must be a valid URL");
  }
  if (typeof senderAssistantId !== "string" || !senderAssistantId) {
    throw new BadRequestError(
      "senderAssistantId is required and must be a non-empty string",
    );
  }
  if (typeof token !== "string" || !token) {
    throw new BadRequestError(
      "token is required and must be a non-empty string",
    );
  }

  const result = await acceptA2AInvite({
    senderGatewayUrl,
    senderAssistantId,
    token,
  });
  if (!result.success) {
    const isSenderFault =
      result.errorCode === "sender_unreachable" ||
      result.errorCode === "complete_failed";
    if (isSenderFault) {
      throw new BadGatewayError(result.error ?? "Failed to accept A2A invite");
    }
    throw new BadRequestError(result.error ?? "Failed to accept A2A invite");
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
    policy: null,
    summary: "Get A2A config",
    description: "Check current A2A channel configuration status.",
    tags: ["integrations"],
    handler: () => handleGetA2AConfig(),
    responseBody: A2AConfigResultSchema,
  },
  {
    operationId: "integrations_a2a_config_post",
    endpoint: "integrations/a2a/config",
    method: "POST",
    policy: null,
    summary: "Enable A2A channel",
    description: "Enable the A2A channel for inter-assistant communication.",
    tags: ["integrations"],
    handler: () => handleSetA2AConfig(),
    responseBody: A2AConfigResultSchema,
  },
  {
    operationId: "integrations_a2a_config_delete",
    endpoint: "integrations/a2a/config",
    method: "DELETE",
    policy: null,
    summary: "Disable A2A channel",
    description: "Disable the A2A channel.",
    tags: ["integrations"],
    handler: () => handleClearA2AConfig(),
    responseBody: A2AConfigResultSchema,
  },
  {
    operationId: "integrations_a2a_invite_post",
    endpoint: "integrations/a2a/invite",
    method: "POST",
    policy: {
      requiredScopes: ["settings.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Create A2A invite",
    description:
      "Create a shareable A2A invite token for link-based contact creation.",
    tags: ["integrations"],
    handler: handleCreateA2AInvite,
    responseBody: CreateA2AInviteResultSchema,
  },
  {
    operationId: "integrations_a2a_invite_complete_post",
    endpoint: "integrations/a2a/invite/complete",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Complete A2A invite (sender side)",
    description:
      "Called by the platform to finalize the sender side of a link-based A2A connection.",
    tags: ["integrations"],
    handler: handleCompleteA2AInvite,
    responseBody: CompleteA2AInviteResultSchema,
  },
  {
    operationId: "integrations_a2a_invite_redeem_post",
    endpoint: "integrations/a2a/invite/redeem",
    method: "POST",
    policy: {
      requiredScopes: ["internal.write"],
      allowedPrincipalTypes: GATEWAY_PRINCIPALS,
    },
    summary: "Redeem A2A invite (receiver side)",
    description:
      "Called by the platform to create a trusted contact on the receiver side of a link-based A2A connection.",
    tags: ["integrations"],
    handler: handleRedeemA2AInvite,
    responseBody: RedeemA2AInviteResultSchema,
  },
  {
    operationId: "integrations_a2a_invite_accept_post",
    endpoint: "integrations/a2a/invite/accept",
    method: "POST",
    policy: null,
    summary: "Accept A2A invite (self-hosted broker)",
    description:
      "Orchestrate cross-daemon invite acceptance for self-hosted deployments. Calls the sender's invite/complete, then creates a local contact via invite/redeem.",
    tags: ["integrations"],
    handler: handleAcceptA2AInvite,
    responseBody: AcceptA2AInviteResultSchema,
  },
];
