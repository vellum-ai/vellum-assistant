/**
 * Route handlers for A2A integration config endpoints.
 *
 * GET    /v1/integrations/a2a/config    — get current A2A config status
 * POST   /v1/integrations/a2a/config    — enable A2A channel
 * DELETE /v1/integrations/a2a/config    — disable A2A channel
 * POST   /v1/integrations/a2a/connect   — initiate connection to a peer assistant
 */

import { isA2AEnabled } from "../../../a2a/feature-gate.js";
import { getConfig } from "../../../config/loader.js";
import {
  clearA2AConfig,
  connectToAssistant,
  getA2AConfig,
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

async function handleConnectToAssistant({ body = {} }: RouteHandlerArgs) {
  assertA2AFlag();
  const { guardianHandle, gatewayUrl } = body as {
    guardianHandle?: string;
    gatewayUrl?: string;
  };
  if (!guardianHandle) {
    throw new BadRequestError("guardianHandle is required");
  }
  const result = await connectToAssistant({ guardianHandle, gatewayUrl });
  if (!result.success) {
    throw new BadRequestError(result.error ?? "Failed to connect to assistant");
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
    operationId: "integrations_a2a_connect_post",
    endpoint: "integrations/a2a/connect",
    method: "POST",
    summary: "Connect to assistant",
    description:
      "Initiate an A2A connection to a peer assistant by guardian handle.",
    tags: ["integrations"],
    requirePolicyEnforcement: true,
    handler: handleConnectToAssistant,
  },
];
