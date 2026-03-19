import SwiftUI
import VellumAssistantShared

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
        }
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
                sendDiagnostics: store.sendDiagnostics
            )
        }
    }
}
