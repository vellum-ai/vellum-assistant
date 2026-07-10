/**
 * A2A agent card discovery endpoint:
 * - GET /.well-known/agent-card.json — agent card for peer discovery
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { GatewayConfig } from "../../config.js";
import type { ConfigFileCache } from "../../config-file-cache.js";
import type { CredentialCache } from "../../credential-cache.js";
import { credentialKey } from "../../credential-key.js";
import { getWorkspaceDir } from "../../credential-reader.js";
import { getLogger } from "../../logger.js";
import { resolvePublicHttpBaseUrl } from "../../runtime/client.js";

const log = getLogger("a2a-routes");

// ── A2A protocol constants (duplicated to avoid cross-package import) ──

const A2A_AGENT_CARD_PATH = "/.well-known/agent-card.json";

// ── Agent card builder ──────────────────────────────────────────────

interface AgentCard {
  name: string;
  description: string;
  version: string;
  supported_interfaces: Array<{
    url: string;
    protocol_binding: string;
    protocol_version: string;
  }>;
  capabilities: {
    streaming: boolean;
    push_notifications: boolean;
    extended_agent_card: boolean;
  };
  default_input_modes: string[];
  default_output_modes: string[];
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
  }>;
}

function buildAgentCard(baseUrl: string, assistantName: string): AgentCard {
  return {
    name: assistantName,
    description: `${assistantName} — a Vellum AI assistant`,
    version: "1.0.0",
    supported_interfaces: [
      {
        url: `${baseUrl}/a2a/message:send`,
        protocol_binding: "JSONRPC",
        protocol_version: "1.0",
      },
    ],
    capabilities: {
      streaming: false,
      push_notifications: true,
      extended_agent_card: false,
    },
    default_input_modes: ["text/plain"],
    default_output_modes: ["text/plain"],
    skills: [
      {
        id: "conversation",
        name: "General conversation",
        description: "Send a message and receive a response",
        tags: ["chat"],
      },
    ],
  };
}

// ── Identity helpers ───────────────────────────────────────────────

function readAssistantName(): string {
  try {
    const wsDir = getWorkspaceDir();
    const identityPath = join(wsDir, "prompts", "IDENTITY.md");
    if (!existsSync(identityPath)) return "Vellum Assistant";
    const content = readFileSync(identityPath, "utf-8");
    const match = content.match(/\*\*Name:\*\*\s*(.+)/);
    return match?.[1]?.trim() || "Vellum Assistant";
  } catch {
    return "Vellum Assistant";
  }
}

// ── Route handler factory ──────────────────────────────────────────

export function createAgentCardHandler(
  config: GatewayConfig,
  configFile: ConfigFileCache,
  credentials: CredentialCache,
) {
  return async (_req: Request): Promise<Response> => {
    const enabled = configFile.getBoolean("a2a", "enabled") ?? false;
    if (!enabled) {
      return Response.json(
        { error: "A2A channel is not enabled" },
        { status: 404 },
      );
    }

    // GET handler — resolve the public URL (with the Velay fallback) but never
    // mutate config here; auto-enabling ingress is reserved for the explicit
    // credential-mint action.
    const platformAssistantId = (
      await credentials.get(credentialKey("vellum", "platform_assistant_id"))
    )?.trim();
    const publicBaseUrl = resolvePublicHttpBaseUrl(
      config,
      configFile,
      platformAssistantId,
    );
    if (!publicBaseUrl) {
      log.warn("Agent card requested but no public base URL configured");
      return Response.json(
        { error: "Public ingress URL not configured" },
        { status: 503 },
      );
    }

    const assistantName = readAssistantName();
    const card = buildAgentCard(publicBaseUrl, assistantName);

    return Response.json(card, {
      headers: { "Content-Type": "application/json" },
    });
  };
}

export { A2A_AGENT_CARD_PATH };
