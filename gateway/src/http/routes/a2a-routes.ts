/**
 * A2A agent card discovery endpoint:
 * - GET /.well-known/agent-card.json — agent card for peer discovery
 */

import type { ConfigFileCache } from "../../config-file-cache.js";
import { getLogger } from "../../logger.js";

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

// ── Route handler factory ──────────────────────────────────────────

export function createAgentCardHandler(configFile: ConfigFileCache) {
  return async (_req: Request): Promise<Response> => {
    const enabled = configFile.getBoolean("a2a", "enabled") ?? false;
    if (!enabled) {
      return Response.json(
        { error: "A2A channel is not enabled" },
        { status: 404 },
      );
    }

    const publicBaseUrl =
      configFile.getString("ingress", "publicBaseUrl") ?? "";
    if (!publicBaseUrl) {
      log.warn("Agent card requested but no public base URL configured");
      return Response.json(
        { error: "Public ingress URL not configured" },
        { status: 503 },
      );
    }

    const assistantName = "Vellum Assistant";
    const card = buildAgentCard(publicBaseUrl, assistantName);

    return Response.json(card, {
      headers: { "Content-Type": "application/json" },
    });
  };
}

export { A2A_AGENT_CARD_PATH };
