import SwiftUI
import VellumAssistantShared
import os

private let privacyTabLog = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "SettingsPrivacyTab"
)

/// UserDefaults key for the cached LLM request log retention value (Int64 ms).
/// Seeded from the last known daemon value so the picker renders instantly
/// on next open before the GET completes.
private let llmRequestLogRetentionMsDefaultsKey = "llmRequestLogRetentionMs"

/// Privacy settings tab — lets the user control usage analytics and
/// crash/error diagnostics independently.
@MainActor
struct SettingsPrivacyTab: View {
    @ObservedObject var store: SettingsStore
    var featureFlagClient: FeatureFlagClientProtocol = FeatureFlagClient()

    /// Tracks the in-flight privacy sync task so rapid toggles cancel the
    /// previous write and only the latest values reach the daemon.
    /// A single task suffices because `syncPrivacyConfig()` always sends
    /// both current store values, so cancelling one toggle's task cannot
    /// silently drop the other toggle's change.
    @State private var privacySyncTask: Task<Void, Never>?

    /// Current selection for the LLM request log retention picker.
    /// Seeded from UserDefaults on view appear for instant render, then
    /// reconciled against the daemon's authoritative value via
    /// `loadPrivacyConfig()`.
    @State private var retentionSelection: LlmLogRetentionOption = .oneDay

    /// In-flight retention sync task so rapid picker changes cancel the
    /// previous write and only the latest selection reaches the daemon.
    @State private var retentionSyncTask: Task<Void, Never>?

    /// In-flight retention load task so repeated view appearances don't
    /// stack concurrent GETs against the gateway.
    @State private var retentionLoadTask: Task<Void, Never>?

    /// Tracks whether the user has actively picked a retention option since
    /// the view appeared. Once set, `loadPrivacyConfig()` will NOT overwrite
    /// `retentionSelection` with the daemon's reconciled value — otherwise a
    /// late GET response could stomp a user's mid-load selection with stale
    /// server data. Complements the `Binding(get:set:)` guard that prevents
    /// programmatic assignments from spuriously triggering `syncRetention`.
    @State private var hasUserInteracted: Bool = false

    var body: some View {
        privacySection
    }

    // MARK: - Privacy Section

    private var privacySection: some View {
        SettingsCard(title: "Privacy") {
            VToggle(
                isOn: Binding(
                    get: { store.collectUsageData },
                    set: { newValue in
                        store.collectUsageData = newValue
                        syncPrivacyConfig()
                    }
                ),
                label: "Share Analytics",
                helperText: "Send anonymous product usage data. Your conversations and personal data are never included."
            )
            .frame(maxWidth: .infinity, alignment: .leading)

            SettingsDivider()

            VToggle(
                isOn: Binding(
                    get: { store.sendDiagnostics },
                    set: { newValue in
                        store.sendDiagnostics = newValue
                        if newValue {
                            MetricKitManager.startSentry()
                        } else {
                            MetricKitManager.closeSentry()
                        }
                        syncPrivacyConfig()
                    }
                ),
                label: "Share Diagnostics",
                helperText: "Send crash reports and performance metrics. Your conversations and personal data are never included."
            )
            .frame(maxWidth: .infinity, alignment: .leading)

            SettingsDivider()

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("LLM Request Log Retention")
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                VDropdown(
                    options: LlmLogRetentionOption.allCases.map {
                        VDropdownOption(label: $0.label, value: $0)
                    },
                    selection: Binding(
                        get: { retentionSelection },
                        set: { newValue in
                            hasUserInteracted = true
                            retentionSelection = newValue
                            syncRetention(newValue)
                        }
                    ),
                    maxWidth: 280
                )
                .accessibilityLabel("LLM Request Log Retention")
                Text("How long to keep LLM request and response logs on this device. These logs record the prompts and completions sent to model providers and are used for debugging. Shorter retention improves privacy; longer retention helps troubleshoot issues.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task { await loadPrivacyConfig() }
    }

    // MARK: - Privacy Config Sync

    /// Syncs the full privacy config to the daemon, cancelling any in-flight
    /// sync so that only the latest state wins when the user toggles rapidly.
    ///
    /// Always sends **both** current store values so that cancelling one
    /// toggle's in-flight task cannot silently drop the other toggle's change.
    private func syncPrivacyConfig() {
        privacySyncTask?.cancel()
        privacySyncTask = Task {
            try? await featureFlagClient.setPrivacyConfig(
                collectUsageData: store.collectUsageData,
                sendDiagnostics: store.sendDiagnostics,
                llmRequestLogRetentionMs: nil
            )
        }
    }

    // MARK: - Retention Picker Sync

    /// Loads the current privacy config from the daemon and reconciles the
    /// retention picker selection. First seeds from UserDefaults so the picker
    /// renders instantly on view appear even before the GET completes.
    /// Errors are logged and swallowed — the picker gracefully keeps the
    /// default if the GET fails.
    ///
    /// Race-safety: if the user picks an option *before* the GET completes,
    /// `hasUserInteracted` will be true and the reconciliation assignment
    /// below is skipped so stale server data cannot overwrite the user's
    /// just-made selection. The `Binding(get:set:)` on the picker handles the
    /// inverse race (programmatic assignments do not trigger `syncRetention`).
    private func loadPrivacyConfig() async {
        // Seed from UserDefaults for instant render.
        if let cachedMs = readCachedRetentionMs() {
            retentionSelection = LlmLogRetentionOption.closest(toMs: cachedMs)
        }

        retentionLoadTask?.cancel()
        let task = Task { @MainActor in
            do {
                let config = try await featureFlagClient.getPrivacyConfig()
                guard !Task.isCancelled else { return }
                // If the user has already picked an option, do NOT overwrite
                // their selection with the daemon's pre-PATCH value — the
                // PATCH dispatched by `syncRetention` is the authoritative
                // write and will settle the server state to match.
                guard !hasUserInteracted else { return }
                retentionSelection = LlmLogRetentionOption.closest(
                    toMs: config.llmRequestLogRetentionMs
                )
                UserDefaults.standard.set(
                    config.llmRequestLogRetentionMs,
                    forKey: llmRequestLogRetentionMsDefaultsKey
                )
            } catch {
                privacyTabLog.error(
                    "getPrivacyConfig failed: \(error.localizedDescription, privacy: .public)"
                )
            }
        }
        retentionLoadTask = task
        await task.value
    }

    /// Syncs the selected retention option to the daemon and persists the
    /// selection locally so the picker renders instantly on next open.
    private func syncRetention(_ option: LlmLogRetentionOption) {
        UserDefaults.standard.set(
            option.rawValue,
            forKey: llmRequestLogRetentionMsDefaultsKey
        )
        retentionSyncTask?.cancel()
        retentionSyncTask = Task {
            try? await featureFlagClient.setPrivacyConfig(
                collectUsageData: nil,
                sendDiagnostics: nil,
                llmRequestLogRetentionMs: option.rawValue
            )
        }
    }

    /// Reads the cached retention milliseconds from UserDefaults, handling
    /// both `Int64` and `Int` coercion since `UserDefaults` cannot directly
    /// store `Int64` and may round-trip it through `NSNumber`.
    private func readCachedRetentionMs() -> Int64? {
        guard let raw = UserDefaults.standard.object(
            forKey: llmRequestLogRetentionMsDefaultsKey
        ) else { return nil }
        if let asInt64 = raw as? Int64 { return asInt64 }
        if let asInt = raw as? Int { return Int64(asInt) }
        if let asNumber = raw as? NSNumber { return asNumber.int64Value }
        return nil
    }
}
