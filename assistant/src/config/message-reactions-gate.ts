import { isAssistantFeatureFlagEnabled } from "./assistant-feature-flags.js";
import type { AssistantConfig } from "./schema.js";

const MESSAGE_REACTIONS_FLAG = "message-reactions" as const;

/**
 * Gate for the message-reactions feature: the `send_reaction` tool
 * registration and the `message-reactions` HTTP route both consult this.
 * The client-scope half of the same flag gates the web reaction UI.
 */
export function isMessageReactionsEnabled(config: AssistantConfig): boolean {
  return isAssistantFeatureFlagEnabled(MESSAGE_REACTIONS_FLAG, config);
}
