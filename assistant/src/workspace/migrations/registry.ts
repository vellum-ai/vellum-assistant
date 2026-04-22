import { avatarRenameMigration } from "./001-avatar-rename.js";
import { seedDeviceIdMigration } from "./003-seed-device-id.js";
import { extractCollectUsageDataMigration } from "./004-extract-collect-usage-data.js";
import { addSendDiagnosticsMigration } from "./005-add-send-diagnostics.js";
import { servicesConfigMigration } from "./006-services-config.js";
import { webSearchProviderRenameMigration } from "./007-web-search-provider-rename.js";
import { voiceTimeoutAndMaxStepsMigration } from "./008-voice-timeout-and-max-steps.js";
import { backfillConversationDiskViewMigration } from "./009-backfill-conversation-disk-view.js";
import { appDirRenameMigration } from "./010-app-dir-rename.js";
import { backfillInstallationIdMigration } from "./011-backfill-installation-id.js";
import { renameConversationDiskViewDirsMigration } from "./012-rename-conversation-disk-view-dirs.js";
import { repairConversationDiskViewMigration } from "./013-repair-conversation-disk-view.js";
import { migrateCredentialsToKeychainMigration } from "./015-migrate-credentials-to-keychain.js";
import { extractFeatureFlagsToProtectedMigration } from "./016-extract-feature-flags-to-protected.js";
import { migrateCredentialsFromKeychainMigration } from "./016-migrate-credentials-from-keychain.js";
import { seedPersonaDirsMigration } from "./017-seed-persona-dirs.js";
import { rekeyCompoundCredentialKeysMigration } from "./018-rekey-compound-credential-keys.js";
import { scopeJournalToGuardianMigration } from "./019-scope-journal-to-guardian.js";
import { renameOauthSkillDirsMigration } from "./020-rename-oauth-skill-dirs.js";
import { moveSignalsToWorkspaceMigration } from "./021-move-signals-to-workspace.js";
import { moveHooksToWorkspaceMigration } from "./022-move-hooks-to-workspace.js";
import { moveConfigFilesToWorkspaceMigration } from "./023-move-config-files-to-workspace.js";
import { moveRuntimeFilesToWorkspaceMigration } from "./024-move-runtime-files-to-workspace.js";
import { removeOauthAppSetupSkillsMigration } from "./025-remove-oauth-app-setup-skills.js";
import { backfillInstallMetaMigration } from "./026-backfill-install-meta.js";
import { removeOrphanedOptimizedImagesCacheMigration } from "./027-remove-orphaned-optimized-images-cache.js";
import { recoverConversationsFromDiskViewMigration } from "./028-recover-conversations-from-disk-view.js";
import { seedPkbMigration } from "./029-seed-pkb.js";
import { seedPkbAutoinjectMigration } from "./030-seed-pkb-autoinject.js";
import { dropUserMdMigration } from "./031-drop-user-md.js";
import { llmLogRetentionZeroToNullMigration } from "./031-llm-log-retention-zero-to-null.js";
import { ttsProviderUnificationMigration } from "./032-tts-provider-unification.js";
import { sttServiceExplicitConfigMigration } from "./033-stt-service-explicit-config.js";
import { removeCallsVoiceTranscriptionProviderMigration } from "./034-remove-calls-voice-transcription-provider.js";
import { seedSlackChannelPersonaMigration } from "./035-seed-slack-channel-persona.js";
import { updatePkbIndexBarMigration } from "./036-update-pkb-index-bar.js";
import { createMeetsDirMigration } from "./037-create-meets-dir.js";
import { unifyLlmCallSiteConfigsMigration } from "./038-unify-llm-callsite-configs.js";
import { dropLegacyLlmKeysMigration } from "./039-drop-legacy-llm-keys.js";
import { seedLatencyCallSiteDefaultsMigration } from "./040-seed-latency-callsite-defaults.js";
import { backfillGoogleGmailSettingsScopeMigration } from "./041-backfill-google-gmail-settings-scope.js";
import { fixBackfillGoogleGmailSettingsScopeMigration } from "./042-fix-backfill-google-gmail-settings-scope.js";
import { releaseNotesLatexRenderingMigration } from "./043-release-notes-latex-rendering.js";
import { bumpStaleProviderStreamTimeoutMigration } from "./044-bump-stale-provider-stream-timeout.js";
import { releaseNotesMeetAvatarMigration } from "./045-release-notes-meet-avatar.js";
import { seedConversationStartersCallsiteMigration } from "./046-seed-conversation-starters-callsite.js";
import { migrateToWorkspaceVolumeMigration } from "./migrate-to-workspace-volume.js";
import type { WorkspaceMigration } from "./types.js";

/**
 * Ordered list of all workspace data migrations.
 * New migrations are appended to the end. Never reorder or remove entries.
 */
export const WORKSPACE_MIGRATIONS: WorkspaceMigration[] = [
  avatarRenameMigration,
  backfillInstallationIdMigration,
  seedDeviceIdMigration,
  extractCollectUsageDataMigration,
  addSendDiagnosticsMigration,
  servicesConfigMigration,
  webSearchProviderRenameMigration,
  voiceTimeoutAndMaxStepsMigration,
  backfillConversationDiskViewMigration,
  appDirRenameMigration,
  renameConversationDiskViewDirsMigration,
  repairConversationDiskViewMigration,
  migrateToWorkspaceVolumeMigration,
  migrateCredentialsToKeychainMigration,
  migrateCredentialsFromKeychainMigration,
  seedPersonaDirsMigration,
  extractFeatureFlagsToProtectedMigration,
  rekeyCompoundCredentialKeysMigration,
  scopeJournalToGuardianMigration,
  renameOauthSkillDirsMigration,
  moveSignalsToWorkspaceMigration,
  moveHooksToWorkspaceMigration,
  moveConfigFilesToWorkspaceMigration,
  moveRuntimeFilesToWorkspaceMigration,
  removeOauthAppSetupSkillsMigration,
  backfillInstallMetaMigration,
  removeOrphanedOptimizedImagesCacheMigration,
  recoverConversationsFromDiskViewMigration,
  seedPkbMigration,
  seedPkbAutoinjectMigration,
  llmLogRetentionZeroToNullMigration,
  ttsProviderUnificationMigration,
  dropUserMdMigration,
  sttServiceExplicitConfigMigration,
  removeCallsVoiceTranscriptionProviderMigration,
  seedSlackChannelPersonaMigration,
  updatePkbIndexBarMigration,
  createMeetsDirMigration,
  unifyLlmCallSiteConfigsMigration,
  dropLegacyLlmKeysMigration,
  seedLatencyCallSiteDefaultsMigration,
  backfillGoogleGmailSettingsScopeMigration,
  fixBackfillGoogleGmailSettingsScopeMigration,
  releaseNotesLatexRenderingMigration,
  bumpStaleProviderStreamTimeoutMigration,
  releaseNotesMeetAvatarMigration,
  seedConversationStartersCallsiteMigration,
];
