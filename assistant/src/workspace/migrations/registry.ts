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
import { removeWatchCallsitesMigration } from "./047-remove-watch-callsites.js";
import { removeWorkspaceHooksMigration } from "./048-remove-workspace-hooks.js";
import { releaseNotesDefaultSonnetMigration } from "./049-release-notes-default-sonnet.js";
import { seedMainAgentOpusCallsiteMigration } from "./050-seed-main-agent-opus-callsite.js";
import { seedConversationSummarizationCallsiteMigration } from "./051-seed-conversation-summarization-callsite.js";
import { seedDefaultInferenceProfiles052 } from "./052-seed-default-inference-profiles.js";
import { releaseNotesAcpCodexMigration } from "./053-release-notes-acp-codex.js";
import { seedRecallCallsiteMigration } from "./054-seed-recall-callsite.js";
import { releaseNotesAgenticRecallMigration } from "./055-release-notes-agentic-recall.js";
import { releaseNotesInferenceProfileReorderingMigration } from "./056-release-notes-inference-profile-reordering.js";
import { repairStaleGeminiModelIdsMigration } from "./057-repair-stale-gemini-model-ids.js";
import { releaseNotesAcpSessionsUiMigration } from "./058-release-notes-acp-sessions-ui.js";
import { movePidToWorkspaceMigration } from "./059-move-pid-to-workspace.js";
import { memoryV2InitMigration } from "./060-memory-v2-init.js";
import { moveBackupKeyToWorkspaceMigration } from "./061-move-backup-key-to-workspace.js";
import { dropMemoryV2EdgesJsonMigration } from "./062-drop-memory-v2-edges-json.js";
import { releaseNotesDynamicModelContextMigration } from "./063-release-notes-dynamic-model-context.js";
import { unwindMainAgentOpusSeedMigration } from "./064-unwind-main-agent-opus-seed.js";
import { bumpStaleHeartbeatIntervalMigration } from "./065-bump-stale-heartbeat-interval.js";
import { seedHeartbeatCallsiteCostDefaultMigration } from "./066-seed-heartbeat-callsite-cost-default.js";
import { releaseNotesSafeStorageLimitsMigration } from "./067-release-notes-safe-storage-limits.js";
import { releaseNotesLocalTimezoneMigration } from "./068-release-notes-local-timezone.js";
import { seedOnboardingThreadsMigration } from "./069-seed-onboarding-threads.js";
import { memoryV2SummarySchemaRebuildMigration } from "./070-memory-v2-summary-schema-rebuild.js";
import { removeSafeStorageReleaseNoteMigration } from "./071-remove-safe-storage-release-note.js";
import { seedReplySuggestionCallsiteMigration } from "./072-seed-reply-suggestion-callsite.js";
import { repairRecallCallsiteEmptyProfileMigration } from "./073-repair-recall-callsite-empty-profile.js";
import { dropDeprecatedSecretDetectionKeysMigration } from "./074-drop-deprecated-secret-detection-keys.js";
import { memoryV2Bm25BDefaultReembedMigration } from "./075-memory-v2-bm25-b-default-reembed.js";
import { dropServicesInferenceModeMigration } from "./076-drop-services-inference-mode.js";
import { seedMemoryRouterCallsiteMigration } from "./077-seed-memory-router-callsite.js";
import { releaseNotesTavilyWebSearchMigration } from "./078-release-notes-tavily-web-search.js";
import { homeFeedNotificationOnlyMigration } from "./079-home-feed-notification-only.js";
import { restrictVercelApiTokenMetadataMigration } from "./080-restrict-vercel-api-token-metadata.js";
import { backfillBashAllowedToolsForInjectionCredentialsMigration } from "./081-backfill-bash-allowed-tools-for-injection-credentials.js";
import { backfillManagedProfileLabelsMigration } from "./082-backfill-managed-profile-labels.js";
import { systemPromptPrefixToFileMigration } from "./083-system-prompt-prefix-to-file.js";
import { removeLegacySkillsIndexMigration } from "./084-remove-legacy-skills-index.js";
import { memoryV2Bm25BReembedDisabledV2PagesMigration } from "./085-memory-v2-bm25-b-reembed-disabled-v2-pages.js";
import { revertStaleGeminiMisRewritesMigration } from "./086-revert-stale-gemini-mis-rewrites.js";
import { memoryRouterBalancedProfileMigration } from "./087-memory-router-balanced-profile.js";
import { deprecateBackgroundConversationOverrideMigration } from "./088-deprecate-background-conversation-override.js";
import { moveMemoryTreeOutOfV3Migration } from "./089-move-memory-tree-out-of-v3.js";
import { memoryRouterCostOptimizedProfileMigration } from "./090-memory-router-cost-optimized-profile.js";
import { retightenMigrationOnboardingThreadMigration } from "./091-retighten-migration-onboarding-thread.js";
import { backfillV3LeavesMigration } from "./092-backfill-v3-leaves.js";
import { backfillLeafIdsMigration } from "./093-backfill-leaf-ids.js";
import { seedAvatarManifestMigration } from "./094-seed-avatar-manifest.js";
import { bumpHeartbeatInterval30mTo60mMigration } from "./095-bump-heartbeat-interval-30m-to-60m.js";
import { reduceQualityProfileEffortMigration } from "./096-reduce-quality-profile-effort.js";
import { enableAdaptiveThinkingManagedProfilesMigration } from "./097-enable-adaptive-thinking-managed-profiles.js";
import { removeStaleUpdatesBulletinFileMigration } from "./098-remove-stale-updates-bulletin-file.js";
import { disableCacheOneShotCallsitesMigration } from "./099-disable-cache-one-shot-callsites.js";
import { upgradeQualityProfileToFable5Migration } from "./100-upgrade-quality-profile-to-fable-5.js";
import { upgradeBalancedEconomyToMinimaxM3Migration } from "./101-upgrade-balanced-economy-to-minimax-m3.js";
import { preserveHeartbeatEnabledForExistingWorkspacesMigration } from "./102-preserve-heartbeat-enabled-for-existing-workspaces.js";
import { upgradeQualityProfileToOpus48Migration } from "./103-upgrade-quality-profile-to-opus-4-8.js";
import { recheckAdaptiveThinkingModelImpliedAnthropicMigration } from "./104-recheck-adaptive-thinking-model-implied-anthropic.js";
import { enableMemoryV3LiveForNewWorkspacesMigration } from "./105-enable-memory-v3-live-for-new-workspaces.js";
import { dropCollectUsageDataMigration } from "./106-drop-collect-usage-data.js";
import { dropSendDiagnosticsMigration } from "./107-drop-send-diagnostics.js";
import { dropBalancedEconomyProfileMigration } from "./108-drop-balanced-economy-profile.js";
import { swapQualityProfileToGlm52Migration } from "./109-swap-quality-profile-to-glm-5p2.js";
import { flipBalancedProfileToTogetherMigration } from "./110-flip-balanced-profile-to-together.js";
import { pruneSeededCallsiteDefaultsMigration } from "./111-prune-seeded-callsite-defaults.js";
import { removeAdvisorCallsiteOverrideMigration } from "./112-remove-advisor-callsite-override.js";
import { swapBalancedProfileToGlm52Migration } from "./113-swap-balanced-profile-to-glm-5p2.js";
import { swapQualityProfileToOpusMigration } from "./114-swap-quality-profile-to-opus.js";
import { dropFrontierProfileMigration } from "./115-drop-frontier-profile.js";
import { renameMemoryPluginDisabledSentinelMigration } from "./116-rename-memory-plugin-disabled-sentinel.js";
import { normalizeStaleLeanMemoryV3DefaultsMigration } from "./117-normalize-stale-lean-memory-v3-defaults.js";
import { seedNowMdMigration } from "./118-seed-now-md.js";
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
  removeWatchCallsitesMigration,
  removeWorkspaceHooksMigration,
  releaseNotesDefaultSonnetMigration,
  seedMainAgentOpusCallsiteMigration,
  seedConversationSummarizationCallsiteMigration,
  seedDefaultInferenceProfiles052,
  releaseNotesAcpCodexMigration,
  seedRecallCallsiteMigration,
  releaseNotesAgenticRecallMigration,
  releaseNotesInferenceProfileReorderingMigration,
  repairStaleGeminiModelIdsMigration,
  releaseNotesAcpSessionsUiMigration,
  movePidToWorkspaceMigration,
  memoryV2InitMigration,
  moveBackupKeyToWorkspaceMigration,
  dropMemoryV2EdgesJsonMigration,
  releaseNotesDynamicModelContextMigration,
  unwindMainAgentOpusSeedMigration,
  bumpStaleHeartbeatIntervalMigration,
  seedHeartbeatCallsiteCostDefaultMigration,
  releaseNotesSafeStorageLimitsMigration,
  releaseNotesLocalTimezoneMigration,
  seedOnboardingThreadsMigration,
  memoryV2SummarySchemaRebuildMigration,
  removeSafeStorageReleaseNoteMigration,
  seedReplySuggestionCallsiteMigration,
  repairRecallCallsiteEmptyProfileMigration,
  dropDeprecatedSecretDetectionKeysMigration,
  memoryV2Bm25BDefaultReembedMigration,
  dropServicesInferenceModeMigration,
  seedMemoryRouterCallsiteMigration,
  releaseNotesTavilyWebSearchMigration,
  homeFeedNotificationOnlyMigration,
  restrictVercelApiTokenMetadataMigration,
  backfillBashAllowedToolsForInjectionCredentialsMigration,
  backfillManagedProfileLabelsMigration,
  systemPromptPrefixToFileMigration,
  removeLegacySkillsIndexMigration,
  memoryV2Bm25BReembedDisabledV2PagesMigration,
  revertStaleGeminiMisRewritesMigration,
  memoryRouterBalancedProfileMigration,
  deprecateBackgroundConversationOverrideMigration,
  moveMemoryTreeOutOfV3Migration,
  memoryRouterCostOptimizedProfileMigration,
  retightenMigrationOnboardingThreadMigration,
  backfillV3LeavesMigration,
  backfillLeafIdsMigration,
  seedAvatarManifestMigration,
  bumpHeartbeatInterval30mTo60mMigration,
  reduceQualityProfileEffortMigration,
  enableAdaptiveThinkingManagedProfilesMigration,
  removeStaleUpdatesBulletinFileMigration,
  disableCacheOneShotCallsitesMigration,
  upgradeQualityProfileToFable5Migration,
  upgradeBalancedEconomyToMinimaxM3Migration,
  preserveHeartbeatEnabledForExistingWorkspacesMigration,
  upgradeQualityProfileToOpus48Migration,
  recheckAdaptiveThinkingModelImpliedAnthropicMigration,
  enableMemoryV3LiveForNewWorkspacesMigration,
  dropCollectUsageDataMigration,
  dropSendDiagnosticsMigration,
  dropBalancedEconomyProfileMigration,
  swapQualityProfileToGlm52Migration,
  flipBalancedProfileToTogetherMigration,
  pruneSeededCallsiteDefaultsMigration,
  removeAdvisorCallsiteOverrideMigration,
  swapBalancedProfileToGlm52Migration,
  swapQualityProfileToOpusMigration,
  dropFrontierProfileMigration,
  renameMemoryPluginDisabledSentinelMigration,
  normalizeStaleLeanMemoryV3DefaultsMigration,
  seedNowMdMigration,
];
