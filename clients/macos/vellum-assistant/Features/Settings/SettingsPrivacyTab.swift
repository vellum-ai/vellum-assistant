import SwiftUI
import VellumAssistantShared

/// Privacy settings tab — lets the user control usage analytics and
/// crash/error diagnostics independently.
@MainActor
struct SettingsPrivacyTab: View {
    var daemonClient: DaemonClient?
    @ObservedObject var store: SettingsStore
    var featureFlagClient: FeatureFlagClientProtocol = FeatureFlagClient()

    /// Tracks the in-flight privacy sync task so rapid toggles cancel the
    /// previous write and only the latest value reaches the daemon.
    @State private var privacySyncTask: Task<Void, Never>?

    var body: some View {
        privacySection
    }

    // MARK: - Privacy Section

    private var privacySection: some View {
        SettingsCard(title: "Privacy") {
            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Share Analytics")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                    Text("Send anonymous product usage data. Your conversations and personal data are never included.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
                Spacer()
                VToggle(isOn: Binding(
                    get: { store.collectUsageData },
                    set: { newValue in
                        store.collectUsageData = newValue
                        syncPrivacyConfig(collectUsageData: newValue)
                    }
                ))
            }

            SettingsDivider()

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Share Diagnostics")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                    Text("Send crash reports and performance metrics. Your conversations and personal data are never included.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
                Spacer()
                VToggle(isOn: Binding(
                    get: { store.sendDiagnostics },
                    set: { newValue in
                        store.sendDiagnostics = newValue
                        if newValue {
                            MetricKitManager.startSentry()
                        } else {
                            MetricKitManager.closeSentry()
                        }
                        syncPrivacyConfig(sendDiagnostics: newValue)
                    }
                ))
            }
        }
    }

    // MARK: - Privacy Config Sync

    /// Syncs a privacy config change to the daemon, cancelling any in-flight
    /// sync so that only the latest toggle value wins when the user toggles
    /// rapidly.
    private func syncPrivacyConfig(collectUsageData: Bool? = nil, sendDiagnostics: Bool? = nil) {
        privacySyncTask?.cancel()
        privacySyncTask = Task {
            try? await featureFlagClient.setPrivacyConfig(collectUsageData: collectUsageData, sendDiagnostics: sendDiagnostics)
        }
    }
}
