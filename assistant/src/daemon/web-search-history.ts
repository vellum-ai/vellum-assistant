import type {
  ContentBlock,
  Message,
  ServerToolUseContent,
  TextContent,
  WebSearchToolResultContent,
} from "../providers/types.js";

export interface StripStats {
  blocksStripped: number;
  serverToolUsesDropped: number;
  messagesModified: number;
}

export interface StripResult {
  messages: Message[];
  stats: StripStats;
}

/**
 * Replaces every `web_search_tool_result` block in the message list with a
 * plain `text` summary of its results, and drops the paired `server_tool_use`
 * that produced it, wherever that use lives. The pair usually shares one
 * assistant message, but a deferred execution (the API runs the search on the
 * request after a mixed server/client parallel tool group) places the result
 * at the head of the following assistant message, so pairing is resolved
 * across the whole list. Dropping both sides together keeps the history free
 * of unpaired server-tool blocks, which the provider layer would otherwise
 * repair with a synthetic error result.
 *
 * A `server_tool_use` with no result anywhere in the list is left untouched:
 * either the search is still pending (deferred tail, executed by the provider
 * on this request) or it is a genuine orphan the provider layer repairs.
 *
 * Anthropic's `encrypted_content` tokens attached to each `web_search_result`
 * are opaque server tokens with bounded validity (they expire and/or are
 * route-scoped). Replaying a stale token produces
 * `messages.N.content.M: Invalid encrypted_content in search_result block`.
 * For historical turns the model does not need the opaque token to re-read
 * the body: a title+url summary is sufficient to preserve context.
 *
 * Runs on the outbound message list before each model call; every executed
 * search in the list is summarized regardless of which turn produced it.
 */
export function stripHistoricalWebSearchResults(
  messages: Message[],
): StripResult {
  const stats: StripStats = {
    blocksStripped: 0,
    serverToolUsesDropped: 0,
    messagesModified: 0,
  };

  const strippedToolUseIds = new Set<string>();
  for (const msg of messages) {
    for (const block of msg.content) {
      if (block.type === "web_search_tool_result") {
        strippedToolUseIds.add(
          (block as WebSearchToolResultContent).tool_use_id,
        );
      }
    }
  }

  const next: Message[] = messages.map((msg) => {
    let modified = false;
    const rewritten: ContentBlock[] = [];

    for (const block of msg.content) {
      if (block.type === "server_tool_use") {
        const stu = block as ServerToolUseContent;
        if (strippedToolUseIds.has(stu.id)) {
          stats.serverToolUsesDropped++;
          modified = true;
          continue;
        }
        rewritten.push(block);
      } else if (block.type === "web_search_tool_result") {
        const wsr = block as WebSearchToolResultContent;
        rewritten.push(
          formatAsText(wsr, findQueryForToolUseId(messages, wsr.tool_use_id)),
        );
        stats.blocksStripped++;
        modified = true;
      } else {
        rewritten.push(block);
      }
    }

    if (!modified) {
      return msg;
    }
    stats.messagesModified++;
    return { ...msg, content: rewritten };
  });

  return { messages: next, stats };
}

function findQueryForToolUseId(
  messages: Message[],
  toolUseId: string,
): string | null {
  for (const msg of messages) {
    for (const b of msg.content) {
      if (b.type !== "server_tool_use") {
        continue;
      }
      const stu = b as ServerToolUseContent;
      if (stu.id !== toolUseId) {
        continue;
      }
      const q = stu.input?.query;
      return typeof q === "string" ? q : null;
    }
  }
  return null;
}

function formatAsText(
  block: WebSearchToolResultContent,
  query: string | null,
): TextContent {
  const header = query
    ? `[Prior web_search results for "${query}":`
    : "[Prior web_search results:";

  const content = block.content;
  if (!Array.isArray(content)) {
    return { type: "text", text: `${header} (results unavailable)]` };
  }

  const entries = content
    .filter(
      (r): r is { type: string; title?: unknown; url?: unknown } =>
        typeof r === "object" &&
        r != null &&
        (r as { type?: string }).type === "web_search_result",
    )
    .map((r, i) => {
      const title = typeof r.title === "string" ? r.title : "(untitled)";
      const url = typeof r.url === "string" ? r.url : "";
      return url ? `${i + 1}. ${title}\n   ${url}` : `${i + 1}. ${title}`;
    });

  const body = entries.length > 0 ? entries.join("\n") : "(no results)";
  return { type: "text", text: `${header}\n${body}]` };
}
