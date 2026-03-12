import SwiftUI
import VellumAssistantShared

/// Privacy settings tab — lets the user opt out of crash reporting and
/// error diagnostics sent to help improve the app.
@MainActor
struct SettingsPrivacyTab: View {
    var daemonClient: DaemonClient?
    @ObservedObject var store: SettingsStore

    private static let collectUsageDataKey = "feature_flags.collect-usage-data.enabled"

    @State private var collectUsageData: Bool = true
    @State private var isLoading: Bool = false
    @State private var isUpdating: Bool = false
    @State private var loadError: String?

    var body: some View {
        diagnosticsSection
            .onAppear {
                Task { await loadPrivacyFlags() }
            }
    }

    // MARK: - Diagnostics Section

    private var diagnosticsSection: some View {
        SettingsCard(title: "Diagnostics") {
            if isLoading {
                HStack {
                    Spacer()
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                }
            }

            if let error = loadError {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.triangleAlert, size: 12)
                        .foregroundColor(VColor.systemNegativeHover)
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(VColor.systemNegativeStrong)
                }
            }

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
                        let previousPerfMetrics = store.sendPerformanceReports
                        collectUsageData = newValue
                        if !newValue {
                            store.sendPerformanceReports = false
                        }
                        Task { await setCollectUsageData(newValue, previousPerfMetrics: previousPerfMetrics) }
                    }
                ))
                .disabled(isLoading || isUpdating || daemonClient == nil)
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
                .disabled(!collectUsageData || isLoading || isUpdating)
            }
        }
    }

    // MARK: - Data Loading

    private func loadPrivacyFlags() async {
        guard let daemonClient else { return }
        isLoading = true
        loadError = nil
        do {
            let flags = try await daemonClient.getFeatureFlags()
            if let flag = flags.first(where: { $0.key == Self.collectUsageDataKey }) {
                collectUsageData = flag.enabled
            }
            // If the flag is not present in the registry response, default to true
            // (matches the registry defaultEnabled: true).
        } catch {
            loadError = "Could not load privacy settings: \(error.localizedDescription)"
        }
        isLoading = false
    }

    private func setCollectUsageData(_ enabled: Bool, previousPerfMetrics: Bool = false) async {
        guard let daemonClient else { return }
        isUpdating = true
        do {
            try await daemonClient.setFeatureFlag(key: Self.collectUsageDataKey, enabled: enabled)
            // Clear any previous error so stale failure messages don't persist after a successful save.
            loadError = nil
            // Apply Sentry state immediately rather than waiting for the next daemon
            // reconnect to call checkAndApplyPrivacyFlag(). Both paths are serialised
            // through sentrySerialQueue so they don't race with concurrent MetricKit
            // captures or manual report sends.
            // Persist so MetricKitManager can check this flag synchronously
            // during the startup window before the daemon connects.
            UserDefaults.standard.set(enabled, forKey: "collectUsageDataEnabled")
            if enabled {
                MetricKitManager.startSentry()
            } else {
                MetricKitManager.closeSentry()
            }
        } catch {
            // Revert the optimistic toggle on failure, including the
            // cascaded performance metrics toggle — restore to its
            // previous value rather than blindly setting true.
            collectUsageData = !enabled
            if !enabled {
                store.sendPerformanceReports = previousPerfMetrics
            }
            loadError = "Could not save privacy setting: \(error.localizedDescription)"
        }
        isUpdating = false
    }
}

#Preview("SettingsPrivacyTab") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        SettingsPrivacyTab(daemonClient: nil, store: SettingsStore())
            .frame(width: 480)
            .padding()
    }
}
