import { isAssistantFeatureFlagEnabled } from "../config/assistant-feature-flags.js";
import { getIsContainerized } from "../config/env-registry.js";
import { getConfig } from "../config/loader.js";
import { getWorkspacePromptPath } from "../util/platform.js";
import {
  buildCliReferenceSection,
  buildConfigSection,
  buildContainerizedSection,
  readPromptFile,
} from "./sections/core.js";
import {
  buildAccessPreferenceSection,
  buildAttachmentSection,
  buildInChatConfigurationSection,
  buildIntegrationSection,
  buildPostToolResponseSection,
  buildStarterTaskRoutingSection,
  buildSwarmGuidanceSection,
  buildSystemPermissionSection,
  buildToolPermissionSection,
} from "./sections/operations.js";
import { buildPersistenceSection } from "./sections/persistence.js";
import {
  buildChannelAwarenessSection,
  buildChannelCommandIntentSection,
  buildExternalCommsIdentitySection,
  buildPhoneCallsRoutingSection,
  buildTaskScheduleReminderRoutingSection,
  buildVerificationRoutingSection,
  buildVoiceSetupRoutingSection,
} from "./sections/routing.js";
import { appendSkillsCatalog } from "./sections/skills.js";

// ── Re-exports ──
// Only re-export symbols that are actually imported from this module
// elsewhere in the codebase. Dead re-exports were removed as part of
// the prompt-size audit (PRs 1-7).

export {
  buildCliReferenceSection,
  ensurePromptFiles,
  stripCommentLines,
} from "./sections/core.js";
export {
  buildChannelAwarenessSection,
} from "./sections/routing.js";

/**
 * Build the system prompt from ~/.vellum prompt files,
 * then append a generated skills catalog (if any skills are available).
 *
 * Composition:
 *   1. Base prompt: IDENTITY.md + SOUL.md (guaranteed to exist after ensurePromptFiles)
 *   2. Append USER.md (user profile)
 *   3. If BOOTSTRAP.md exists, append first-run ritual instructions
 *   4. Append skills catalog from ~/.vellum/workspace/skills
 *
 * ── Prompt philosophy (established in the prompt-size audit, PRs 1-7) ──
 *
 * The base system prompt should contain ONLY universally applicable rules:
 * identity, behavioral foundations, tool permissions, routing dispatch
 * hints, and core operational constraints that apply to every turn.
 *
 * Specific workflows, detailed playbooks, and domain-deep guidance belong
 * in skills (loaded on demand via skill_load) or runtime injections
 * (channel capabilities, attachments, etc.). This keeps the base prompt
 * small and focused, reducing token overhead on every turn. New guidance
 * should be added as a skill unless it genuinely applies to every single
 * conversation turn.
 *
 * Budget guardrails in system-prompt.test.ts enforce that the assembled
 * prompt stays within a character budget and that individual sections do
 * not regress in size without deliberate review.
 */
export function buildSystemPrompt(): string {
  const soulPath = getWorkspacePromptPath("SOUL.md");
  const identityPath = getWorkspacePromptPath("IDENTITY.md");
  const userPath = getWorkspacePromptPath("USER.md");
  const bootstrapPath = getWorkspacePromptPath("BOOTSTRAP.md");

  const updatesPath = getWorkspacePromptPath("UPDATES.md");

  const soul = readPromptFile(soulPath);
  const identity = readPromptFile(identityPath);
  const user = readPromptFile(userPath);
  const bootstrap = readPromptFile(bootstrapPath);
  const updates = readPromptFile(updatesPath);

  // ── Core sections ──
  const parts: string[] = [];
  parts.push(
    "IMPORTANT: Never use em dashes (\u2014) in your messages. Use commas, periods, or just start a new sentence instead.",
  );
  if (identity) parts.push(identity);
  if (soul) parts.push(soul);
  if (user) parts.push(user);
  if (bootstrap) {
    parts.push(
      "# First-Run Ritual\n\n" +
        "BOOTSTRAP.md is present \u2014 this is your first conversation. Follow its instructions.\n\n" +
        bootstrap,
    );
  }
  if (updates) {
    parts.push(
      [
        "## Recent Updates",
        "",
        updates,
        "",
        "### Update Handling",
        "",
        "Use your judgment to decide when and how to surface updates to the user:",
        "- Inform the user about updates that are relevant to what they are doing or asking about.",
        "- Apply assistant-relevant changes (e.g., new tools, behavior adjustments) without forced announcement.",
        "- Do not interrupt the user with updates unprompted \u2014 weave them naturally into conversation when relevant.",
        "- When you are satisfied all updates have been actioned or communicated, delete `UPDATES.md` to signal completion.",
      ].join("\n"),
    );
  }
  if (getIsContainerized()) parts.push(buildContainerizedSection());
  parts.push(buildConfigSection());
  parts.push(buildCliReferenceSection());
  parts.push(buildPostToolResponseSection());
  parts.push(buildExternalCommsIdentitySection());
  parts.push(buildChannelAwarenessSection());
  const config = getConfig();
  parts.push(buildToolPermissionSection());
  parts.push(buildTaskScheduleReminderRoutingSection());
  if (
    isAssistantFeatureFlagEnabled(
      "feature_flags.guardian-verify-setup.enabled",
      config,
    )
  ) {
    parts.push(buildVerificationRoutingSection());
  }
  parts.push(buildAttachmentSection());
  parts.push(buildInChatConfigurationSection());
  parts.push(buildVoiceSetupRoutingSection());
  parts.push(buildPhoneCallsRoutingSection());
  parts.push(buildChannelCommandIntentSection());

  parts.push(buildStarterTaskRoutingSection());
  parts.push(buildSystemPermissionSection());
  parts.push(buildSwarmGuidanceSection());
  parts.push(buildAccessPreferenceSection());
  parts.push(buildIntegrationSection());
  parts.push(buildPersistenceSection());

  return appendSkillsCatalog(parts.join("\n\n"));
}
