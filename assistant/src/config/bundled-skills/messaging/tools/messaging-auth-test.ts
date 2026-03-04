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

  try {
    const provider = resolveProvider(platform);
    return withProviderToken(provider, async (token) => {
      const info = await provider.testConnection(token);
      return ok(JSON.stringify(info, null, 2));
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
