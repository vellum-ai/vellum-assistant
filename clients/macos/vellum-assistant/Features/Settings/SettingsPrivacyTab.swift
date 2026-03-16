import SwiftUI
import VellumAssistantShared

/// Privacy settings tab — lets the user control usage analytics and
/// crash/error diagnostics independently.
@MainActor
struct SettingsPrivacyTab: View {
    var daemonClient: DaemonClient?
    @ObservedObject var store: SettingsStore

    var body: some View {
        privacySection
    }

    // MARK: - Privacy Section

    private var privacySection: some View {
        SettingsCard(title: "Privacy") {
            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Share usage analytics")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                    Text("Send anonymized usage metrics (e.g. token counts, feature adoption) to help us improve the product. No personal data or message content is included.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
                Spacer()
                VToggle(isOn: Binding(
                    get: { store.collectUsageData },
                    set: { newValue in
                        store.collectUsageData = newValue
                        if let daemonClient {
                            Task {
                                try? await daemonClient.setPrivacyConfig(collectUsageData: newValue)
                            }
                        }
                    }
                ))
            }

            SettingsDivider()

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Send diagnostics")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                    Text("Share crash reports, error diagnostics, and performance metrics (hang rate, responsiveness) to help us improve stability. No personal data or message content is included.")
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
                        if let daemonClient {
                            Task {
                                try? await daemonClient.setPrivacyConfig(sendDiagnostics: newValue)
                            }
                        }
                    }
                ))
            }
        }
    }
}
