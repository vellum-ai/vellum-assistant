import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, getProviderConnection, ok, resolveProvider } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const platform = input.platform as string | undefined;

  try {
    const provider = resolveProvider(platform);
    const conn = getProviderConnection(provider);
    const info = await provider.testConnection(conn);
    return ok(JSON.stringify(info, null, 2));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
