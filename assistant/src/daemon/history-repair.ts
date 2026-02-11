import type {
  Message,
  ContentBlock,
  ToolUseContent,
  ToolResultContent,
} from '../providers/types.js';

export interface RepairStats {
  assistantToolResultsRemoved: number;
  missingToolResultsInserted: number;
  orphanToolResultsDowngraded: number;
}

export interface RepairResult {
  messages: Message[];
  stats: RepairStats;
}

const SYNTHETIC_RESULT = '[synthesized: tool result missing from history]';

export function repairHistory(messages: Message[]): RepairResult {
  const stats: RepairStats = {
    assistantToolResultsRemoved: 0,
    missingToolResultsInserted: 0,
    orphanToolResultsDowngraded: 0,
  };

  const result: Message[] = [];
  let pendingToolUseIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      // If previous assistant had unfulfilled tool_use, inject synthetic user message
      if (pendingToolUseIds.size > 0) {
        result.push(buildSyntheticToolResultMessage(pendingToolUseIds));
        stats.missingToolResultsInserted += pendingToolUseIds.size;
        pendingToolUseIds = new Set();
      }

      // Strip tool_result blocks from assistant messages
      const cleanedContent: ContentBlock[] = [];
      for (const block of msg.content) {
        if (block.type === 'tool_result') {
          stats.assistantToolResultsRemoved++;
        } else {
          cleanedContent.push(block);
        }
      }

      result.push({ role: 'assistant', content: cleanedContent });

      // Collect tool_use IDs from this assistant message
      pendingToolUseIds = new Set(
        cleanedContent
          .filter((b): b is ToolUseContent => b.type === 'tool_use')
          .map((b) => b.id),
      );
    } else {
      // User message
      if (pendingToolUseIds.size > 0) {
        const matchedIds = new Set<string>();
        const newContent: ContentBlock[] = [];

        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const tr = block as ToolResultContent;
            if (pendingToolUseIds.has(tr.tool_use_id)) {
              matchedIds.add(tr.tool_use_id);
              newContent.push(block);
            } else {
              stats.orphanToolResultsDowngraded++;
              newContent.push(downgradeToolResult(tr));
            }
          } else {
            newContent.push(block);
          }
        }

        // Inject synthetic tool_result for any unmatched IDs
        for (const id of pendingToolUseIds) {
          if (!matchedIds.has(id)) {
            stats.missingToolResultsInserted++;
            newContent.push({
              type: 'tool_result',
              tool_use_id: id,
              content: SYNTHETIC_RESULT,
              is_error: true,
            });
          }
        }

        result.push({ role: 'user', content: newContent });
        pendingToolUseIds = new Set();
      } else {
        // No pending tool_use — any tool_result here is orphaned
        const newContent: ContentBlock[] = msg.content.map((block) => {
          if (block.type === 'tool_result') {
            stats.orphanToolResultsDowngraded++;
            return downgradeToolResult(block as ToolResultContent);
          }
          return block;
        });

        result.push({ role: 'user', content: newContent });
      }
    }
  }

  // Trailing unfulfilled tool_use at end of history
  if (pendingToolUseIds.size > 0) {
    result.push(buildSyntheticToolResultMessage(pendingToolUseIds));
    stats.missingToolResultsInserted += pendingToolUseIds.size;
  }

  return { messages: result, stats };
}

function buildSyntheticToolResultMessage(ids: Set<string>): Message {
  return {
    role: 'user',
    content: Array.from(ids).map((id) => ({
      type: 'tool_result' as const,
      tool_use_id: id,
      content: SYNTHETIC_RESULT,
      is_error: true,
    })),
  };
}

function downgradeToolResult(tr: ToolResultContent): ContentBlock {
  return {
    type: 'text',
    text: `[orphaned tool_result for ${tr.tool_use_id}]: ${tr.content}`,
  };
}
