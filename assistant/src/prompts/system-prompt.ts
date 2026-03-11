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
import {
  buildLearningMemorySection,
  buildMemoryPersistenceSection,
  buildMemoryRecallSection,
  buildWorkspaceReflectionSection,
} from "./sections/persistence.js";
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
// Preserve the public API so existing importers continue to work.

export {
  _resetCliHelpCache,
  buildCliReferenceSection,
  buildConfigSection,
  buildContainerizedSection,
  ensurePromptFiles,
  isOnboardingComplete,
  stripCommentLines,
} from "./sections/core.js";
export {
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
export {
  buildLearningMemorySection,
  buildMemoryPersistenceSection,
  buildMemoryRecallSection,
  buildWorkspaceReflectionSection,
} from "./sections/persistence.js";
export {
  buildChannelAwarenessSection,
  buildChannelCommandIntentSection,
  buildExternalCommsIdentitySection,
  buildPhoneCallsRoutingSection,
  buildTaskScheduleReminderRoutingSection,
  buildVerificationRoutingSection,
  buildVoiceSetupRoutingSection,
} from "./sections/routing.js";
export { appendSkillsCatalog } from "./sections/skills.js";

/**
 * Build the system prompt from ~/.vellum prompt files,
 * then append a generated skills catalog (if any skills are available).
 *
 * Composition:
 *   1. Base prompt: IDENTITY.md + SOUL.md (guaranteed to exist after ensurePromptFiles)
 *   2. Append USER.md (user profile)
 *   3. If BOOTSTRAP.md exists, append first-run ritual instructions
 *   4. Append skills catalog from ~/.vellum/workspace/skills
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
  parts.push(buildMemoryPersistenceSection());
  parts.push(buildMemoryRecallSection());
  parts.push(buildWorkspaceReflectionSection());
  parts.push(buildLearningMemorySection());

  return appendSkillsCatalog(parts.join("\n\n"));
}
