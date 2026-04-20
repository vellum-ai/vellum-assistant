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
 * that produced it.
 *
 * Anthropic's `encrypted_content` tokens attached to each `web_search_result`
 * are opaque server tokens with bounded validity (they expire and/or are
 * route-scoped). Replaying a stale token produces
 * `messages.N.content.M: Invalid encrypted_content in search_result block`.
 * For historical turns the model does not need the opaque token to re-read
 * the body — a title+url summary is sufficient to preserve context.
 *
 * Intended to run on `runMessages` immediately before the agent loop starts a
 * new turn, at which point every `web_search_tool_result` in the list is by
 * definition from a prior turn.
 */
export function stripHistoricalWebSearchResults(
  messages: Message[],
): StripResult {
  const stats: StripStats = {
    blocksStripped: 0,
    serverToolUsesDropped: 0,
    messagesModified: 0,
  };

  const next: Message[] = messages.map((msg) => {
    const droppedServerToolUseIds = new Set<string>();
    const transformed: ContentBlock[] = [];

    for (const block of msg.content) {
      if (block.type !== "web_search_tool_result") continue;
      const wsr = block as WebSearchToolResultContent;
      const query = findQueryForToolUseId(msg.content, wsr.tool_use_id);
      transformed.push(formatAsText(wsr, query));
      droppedServerToolUseIds.add(wsr.tool_use_id);
      stats.blocksStripped++;
    }

    if (droppedServerToolUseIds.size === 0) return msg;

    const rewritten: ContentBlock[] = [];
    let wsrIndex = 0;
    for (const block of msg.content) {
      if (block.type === "server_tool_use") {
        const stu = block as ServerToolUseContent;
        if (droppedServerToolUseIds.has(stu.id)) {
          stats.serverToolUsesDropped++;
          continue;
        }
        rewritten.push(block);
      } else if (block.type === "web_search_tool_result") {
        rewritten.push(transformed[wsrIndex++]);
      } else {
        rewritten.push(block);
      }
    }

    stats.messagesModified++;
    return { ...msg, content: rewritten };
  });

  return { messages: next, stats };
}

function findQueryForToolUseId(
  blocks: ContentBlock[],
  toolUseId: string,
): string | null {
  for (const b of blocks) {
    if (b.type !== "server_tool_use") continue;
    const stu = b as ServerToolUseContent;
    if (stu.id !== toolUseId) continue;
    const q = stu.input?.query;
    return typeof q === "string" ? q : null;
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
