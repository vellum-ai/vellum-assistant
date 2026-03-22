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
  extractFeatureFlagsToProtectedMigration,
];
