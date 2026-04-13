import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { WorkspaceMigration } from "./types.js";

// Inlined template snapshot so this migration is self-contained even if
// the bundled template file changes or moves in a future release.
const SLACK_CHANNEL_PERSONA_TEMPLATE = `_ Lines starting with _ are comments - they won't appear in the system prompt
_ This file shapes how you behave when responding in Slack. Edit it freely.

# Slack

## Delivery

Skip the research narration. In Slack, every message you send before your final answer posts as a separate visible message - not a live stream. "Let me look that up" and "Researching now..." just add noise. Use your tools, then deliver the result.

Your personality, warmth, humor, and opinions are welcome. Just don't narrate the process of finding the answer.

## Formatting

Never use markdown tables (pipe-delimited). Slack cannot render them. Use bullet points with bold labels instead.

When presenting information from web search, cite sources as inline hyperlinks woven into your text (e.g., "the round closed at $122B, [per CNBC](url)"). Don't dump a references list at the end.

## Long-form content

When your response would be long, dense, or highly structured (reports, teardowns, detailed analyses), use your judgment on whether to write it as an attached file vs posting inline. Consider what reads better in Slack - a wall of text with "See more" truncation often doesn't.
`;

export const seedSlackChannelPersonaMigration: WorkspaceMigration = {
  id: "035-seed-slack-channel-persona",
  description: "Seed channels/slack.md persona template for Slack responses",

  down(_workspaceDir: string): void {
    // No-op: we don't delete user-editable files on rollback.
  },

  run(workspaceDir: string): void {
    const channelsDir = join(workspaceDir, "channels");
    mkdirSync(channelsDir, { recursive: true });

    const slackPath = join(channelsDir, "slack.md");
    if (existsSync(slackPath)) {
      // Don't overwrite user customizations.
      return;
    }

    writeFileSync(slackPath, SLACK_CHANNEL_PERSONA_TEMPLATE, "utf-8");
  },
};
