import Foundation
import os
import VellumAssistantShared

private let migrationLog = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "SettingsStoreScopedMigration"
)

enum SettingsStoreScopedMigration {
    /// Canonical list of UserDefaults keys that are per-assistant and should
    /// be copied into scoped storage the first time the multi-platform
    /// assistant flag flips on for a given assistant id.
    ///
    /// The migration helper iterates this list directly — there is no
    /// separate documentation block; this array is the spec.
    ///
    /// Install-global keys (e.g. `sendDiagnostics`, `collectUsageData`)
    /// are intentionally absent.
    static let perAssistantKeys: [String] = [
        "selectedImageGenModel",
        "cmdEnterToSend",
        "globalHotkeyShortcut",
        "quickInputHotkeyShortcut",
        "quickInputHotkeyKeyCode",
        "sidebarToggleShortcut",
        "newChatShortcut",
        "currentConversationShortcut",
        "popOutShortcut",
    ]

    /// Name of the feature flag that gates the entire multi-platform assistant
    /// migration. When false, settings reads and writes continue to use the
    /// legacy unscoped keys — byte-for-byte today's behavior.
    static let featureFlagKey = "multi-platform-assistant"

    /// Suffix for the idempotency sentinel stored alongside the scoped keys.
    /// A value of `true` means this assistant's legacy keys have already been
    /// copied into scope once.
    static let sentinelSuffix = "__settings_migrated_v1"

    /// One-time, idempotent, flag-gated copy of legacy per-assistant settings
    /// into `"<assistantId>.<key>"` scoped storage. Mirrors the guard / copy /
    /// sentinel pattern in
    /// `AppDelegate+ConnectionSetup.migrateConnectedAssistantIdToLockfile()`.
    ///
    /// - Returns: `true` if a copy pass ran for this call, `false` if it was
    ///   skipped (flag off or sentinel already set). Exposed primarily for
    ///   tests.
    @MainActor
    @discardableResult
    static func migratePerAssistantKeysIfNeeded(
        activeAssistantId: String,
        featureFlagStore: AssistantFeatureFlagStore,
        defaults: UserDefaults = .standard
    ) -> Bool {
        guard featureFlagStore.isEnabled(featureFlagKey) else {
            return false
        }

        let sentinelKey = "\(activeAssistantId).\(sentinelSuffix)"
        if defaults.bool(forKey: sentinelKey) {
            return false
        }

        let scoped = ScopedDefaults(assistantId: activeAssistantId, defaults: defaults)
        var copiedCount = 0
        for key in perAssistantKeys {
            guard let legacyValue = defaults.object(forKey: key) else { continue }
            // Never delete the legacy key — cleanup lives in a separate
            // post-bake PR once this migration has baked across all installs.
            scoped.set(legacyValue, forKey: key)
            copiedCount += 1
        }

        defaults.set(true, forKey: sentinelKey)
        migrationLog.info(
            "Migrated per-assistant settings into scope '\(activeAssistantId, privacy: .public)' (\(copiedCount, privacy: .public) keys)"
        )
        return true
    }
}
