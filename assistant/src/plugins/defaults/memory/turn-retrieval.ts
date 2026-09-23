import type { TurnContext } from "../../types.js";

/** Gates fresh retrieval only; history and static memory remain available. */
export function shouldRetrieveTurnMemory(
  ctx: Pick<TurnContext, "callSite" | "skipMemoryRetrieval">,
): boolean {
  return ctx.callSite !== "voiceFrontDoor" && ctx.skipMemoryRetrieval !== true;
}
