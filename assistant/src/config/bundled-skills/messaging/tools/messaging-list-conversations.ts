import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, ok, resolveProvider, withProviderToken } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const platform = input.platform as string | undefined;
  const types = input.types as string[] | undefined;
  const limit = input.limit as number | undefined;

  try {
    const provider = resolveProvider(platform);
    return withProviderToken(provider, async (token) => {
      const conversations = await provider.listConversations(token, {
        types: types as Array<"channel" | "dm" | "group" | "inbox"> | undefined,
        limit,
      });
      return ok(JSON.stringify(conversations, null, 2));
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
