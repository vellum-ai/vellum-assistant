import SwiftUI
import VellumAssistantShared

/// Privacy settings tab — lets the user opt out of crash reporting and
/// error diagnostics sent to help improve the app.
@MainActor
struct SettingsPrivacyTab: View {
    var daemonClient: DaemonClient?
    @ObservedObject var store: SettingsStore

    @State private var collectUsageData: Bool = UserDefaults.standard.object(forKey: "collectUsageDataEnabled") as? Bool ?? true

    var body: some View {
        diagnosticsSection
    }

    // MARK: - Diagnostics Section

    private var diagnosticsSection: some View {
        SettingsCard(title: "Diagnostics") {
            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Collect usage data")
                        .font(VFont.body)
                        .foregroundColor(VColor.contentSecondary)
                    Text("Send crash reports and error diagnostics to help improve the app. No personal data or message content is ever sent.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
                Spacer()
                VToggle(isOn: Binding(
                    get: { collectUsageData },
                    set: { newValue in
                        collectUsageData = newValue
                        if !newValue {
                            store.sendPerformanceReports = false
                        }
                        setCollectUsageData(newValue)
                    }
                ))
            }

            SettingsDivider()

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Share performance metrics")
                        .font(VFont.body)
                        .foregroundColor(collectUsageData ? VColor.contentSecondary : VColor.contentTertiary)
                    Text(collectUsageData
                         ? "Send anonymised performance metrics (hang rate, scroll speed) to help us improve responsiveness. No personal data or message content is included."
                         : "Requires \"Collect usage data\" to be enabled.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
                Spacer()
                VToggle(isOn: Binding(
                    get: { store.sendPerformanceReports },
                    set: { store.sendPerformanceReports = $0 }
                ))
                .disabled(!collectUsageData)
            }
        }
    }

    // MARK: - Privacy Config

    private func setCollectUsageData(_ enabled: Bool) {
        // UserDefaults is the source of truth
        UserDefaults.standard.set(enabled, forKey: "collectUsageDataEnabled")

        // Apply Sentry state immediately
        if enabled {
            MetricKitManager.startSentry()
        } else {
            MetricKitManager.closeSentry()
        }

        // Best-effort sync to daemon config for next restart
        if let daemonClient {
            Task {
                try? await daemonClient.setPrivacyConfig(collectUsageData: enabled)
            }
        }
    }
}
