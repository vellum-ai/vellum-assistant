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
  const types = input.types as string[] | undefined;
  const limit = input.limit as number | undefined;

  try {
    const provider = await resolveProvider(platform);
    const account = input.account as string | undefined;
    const conn = await getProviderConnection(provider, account);
    const conversations = await provider.listConversations(conn, {
      types: types as Array<"channel" | "dm" | "group" | "inbox"> | undefined,
      limit,
    });
    return ok(JSON.stringify(conversations, null, 2));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
