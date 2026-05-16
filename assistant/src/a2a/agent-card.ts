/**
 * A2A v1.0 agent card builder.
 *
 * `buildAgentCard()` constructs a spec-compliant agent card from explicit
 * parameters. `getAgentCard()` is a convenience wrapper that reads the
 * assistant name and public base URL from workspace config.
 */

import { getConfig } from "../config/loader.js";
import { getAssistantName } from "../daemon/identity-helpers.js";
import { getPublicBaseUrl } from "../inbound/public-ingress-urls.js";
import type { AgentCard } from "./protocol-types.js";

export interface BuildAgentCardParams {
  assistantName: string;
  assistantDescription?: string;
  baseUrl: string;
}

export function buildAgentCard(params: BuildAgentCardParams): AgentCard {
  return {
    name: params.assistantName,
    description:
      params.assistantDescription ??
      `${params.assistantName} — a Vellum AI assistant`,
    version: "1.0.0",
    supported_interfaces: [
      {
        url: `${params.baseUrl}/a2a/message:send`,
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

export function getAgentCard(): AgentCard {
  const config = getConfig();
  const assistantName = getAssistantName() ?? "Vellum Assistant";
  const baseUrl = getPublicBaseUrl(config);

  return buildAgentCard({ assistantName, baseUrl });
}
