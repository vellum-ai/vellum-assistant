import type { Message } from "../../../../messaging/provider-types.js";
import { wrapUntrustedContent } from "../../../../security/untrusted-content.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, getProviderConnection, ok, resolveProvider } from "./shared.js";

function wrapMessageContent(msg: Message): Message {
  const source = msg.platform === "gmail" ? "email" : "slack";
  return {
    ...msg,
    text: wrapUntrustedContent(msg.text, {
      source,
      sourceDetail: msg.sender.email ?? msg.sender.name,
    }),
  };
}

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
    const provider = await resolveProvider(platform);
    const account = input.account as string | undefined;
    const conn = await getProviderConnection(provider, account);
    const result = await provider.search(conn, query, { count: maxResults });
    return ok(
      JSON.stringify(
        { ...result, messages: result.messages.map(wrapMessageContent) },
        null,
        2,
      ),
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
