/**
 * A2A v1.0 agent card builder.
 *
 * `buildAgentCard()` constructs a spec-compliant agent card from explicit
 * parameters. `getAgentCard()` is a convenience wrapper that reads the
 * assistant name from workspace config.
 */

import { getAssistantName } from "../daemon/identity-helpers.js";
import type { AgentCard } from "./protocol-types.js";

export interface BuildAgentCardParams {
  assistantName: string;
  assistantDescription?: string;
}

/**
 * A2A message exchange runs over the authenticated invite flow, so no
 * peer-callable protocol interface is exposed and the card advertises none.
 * An interface entry here would send peers at a URL nothing serves.
 */
export function buildAgentCard(params: BuildAgentCardParams): AgentCard {
  return {
    name: params.assistantName,
    description:
      params.assistantDescription ??
      `${params.assistantName} - a Vellum AI assistant`,
    version: "1.0.0",
    supported_interfaces: [],
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
  return buildAgentCard({
    assistantName: getAssistantName() ?? "Vellum Assistant",
  });
}
