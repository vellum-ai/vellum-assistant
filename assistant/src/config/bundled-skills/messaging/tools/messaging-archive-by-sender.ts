import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, getProviderConnection, ok, resolveProvider } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  if (!context.triggeredBySurfaceAction && !context.batchAuthorizedByTask) {
    return err(
      "This tool requires either a surface action or a scheduled task run with this tool in required_tools. Present results in a selection table with action buttons and wait for the user to click before proceeding.",
    );
  }

  const platform = input.platform as string | undefined;
  const query = input.query as string;

  if (!query) {
    return err("query is required.");
  }

  try {
    const provider = await resolveProvider(platform);

    if (!provider.archiveByQuery) {
      return err(
        `The ${provider.displayName} provider does not support archive by query.`,
      );
    }

    const account = input.account as string | undefined;
    const conn = await getProviderConnection(provider, account);
    const result = await provider.archiveByQuery!(conn, query);

    if (result.archived === 0) {
      return ok("No messages matched the query. Nothing archived.");
    }

    const summary = `Archived ${result.archived} message(s) matching query: ${query}`;
    if (result.truncated) {
      return ok(
        `${summary}\n\nNote: this operation was capped at 5000 messages. Additional messages matching the query may remain in the inbox. Run the command again to archive more.`,
      );
    }
    return ok(summary);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
