/**
 * A2A agent card discovery endpoint:
 * - GET /.well-known/agent-card.json — agent card for peer discovery
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { ConfigFileCache } from "../../config-file-cache.js";
import { getWorkspaceDir } from "../../credential-reader.js";
import { getLogger } from "../../logger.js";

const log = getLogger("a2a-routes");

// ── A2A protocol constants (duplicated to avoid cross-package import) ──

const A2A_AGENT_CARD_PATH = "/.well-known/agent-card.json";

// ── Agent card builder ──────────────────────────────────────────────

export interface AgentCard {
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

/**
 * The gateway serves agent-card discovery only. A2A message exchange runs over
 * the authenticated invite flow, so no peer-callable protocol interface is
 * exposed and the card advertises none: a peer reads zero interfaces and stops,
 * rather than following a URL that matches no route and 404s.
 *
 * `route-schema-guard.test.ts` cross-checks every advertised interface URL
 * against the gateway route table, so restoring an entry here requires
 * registering the route that serves it.
 */
export function buildAgentCard(assistantName: string): AgentCard {
  return {
    name: assistantName,
    description: `${assistantName} - a Vellum AI assistant`,
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

export function createAgentCardHandler(configFile: ConfigFileCache) {
  return async (_req: Request): Promise<Response> => {
    const enabled = configFile.getBoolean("a2a", "enabled") ?? false;
    if (!enabled) {
      return Response.json(
        { error: "A2A channel is not enabled" },
        { status: 404 },
      );
    }

    // An assistant with no public ingress URL cannot be reached for the invite
    // flow the card feeds, so discovery is not yet ready.
    const publicBaseUrl =
      configFile.getString("ingress", "publicBaseUrl") ?? "";
    if (!publicBaseUrl) {
      log.warn("Agent card requested but no public base URL configured");
      return Response.json(
        { error: "Public ingress URL not configured" },
        { status: 503 },
      );
    }

    const card = buildAgentCard(readAssistantName());

    return Response.json(card, {
      headers: { "Content-Type": "application/json" },
    });
  };
}

export { A2A_AGENT_CARD_PATH };
