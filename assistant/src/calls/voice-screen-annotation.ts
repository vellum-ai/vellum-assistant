import { shouldAttachHostProxyForCapability } from "../daemon/host-proxy-preactivation.js";
import { skillLoadTool } from "../tools/skills/load.js";
import type { ToolContext } from "../tools/types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("voice-screen-annotation");

export async function loadVoiceScreenAnnotation(
  context: ToolContext,
): Promise<string | null> {
  if (
    !shouldAttachHostProxyForCapability(
      "host_cu_annotate",
      context.transportInterface,
      context.sourceActorPrincipalId,
    )
  ) {
    return null;
  }
  try {
    const result = await skillLoadTool.execute(
      { skill: "screen-annotation" },
      context,
      { readOnly: true },
    );
    if (result.isError) {
      log.warn(
        { conversationId: context.conversationId, error: result.content },
        "Could not preload screen annotation",
      );
      return null;
    }
    return [
      "The user is sharing their screen. skill_load has automatically loaded screen-annotation for this turn. Use its tools through skill_execute when pointing at the shared screen.",
      result.content,
    ].join("\n\n");
  } catch (err) {
    log.warn(
      { err, conversationId: context.conversationId },
      "Could not preload screen annotation",
    );
    return null;
  }
}
