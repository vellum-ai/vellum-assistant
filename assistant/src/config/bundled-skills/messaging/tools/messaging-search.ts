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
  const query = input.query as string;
  const maxResults = input.max_results as number | undefined;

  if (!query) {
    return err("query is required.");
  }

  try {
    const provider = resolveProvider(platform);
    return withProviderToken(provider, async (token) => {
      const result = await provider.search(token, query, { count: maxResults });
      return ok(JSON.stringify(result, null, 2));
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
