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
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack {
                Text("Diagnostics")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)
                Spacer()
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                }
            }

            if let error = loadError {
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundColor(VColor.warning)
                        .font(.system(size: 12))
                    Text(error)
                        .font(VFont.caption)
                        .foregroundColor(VColor.error)
                }
            }

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Collect usage data")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Text("Send crash reports and error diagnostics to help improve the app. No personal data or message content is ever sent.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
                VToggle(isOn: Binding(
                    get: { collectUsageData },
                    set: { newValue in
                        collectUsageData = newValue
                        Task { await setCollectUsageData(newValue) }
                    }
                ))
                .disabled(isLoading || isUpdating || daemonClient == nil)
            }

            Divider()
                .foregroundColor(VColor.divider)

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Share performance metrics")
                        .font(VFont.body)
                        .foregroundColor(collectUsageData ? VColor.textSecondary : VColor.textMuted)
                    Text(collectUsageData
                         ? "Send anonymised performance metrics (hang rate, scroll speed) to help us improve responsiveness. No personal data or message content is included."
                         : "Requires \"Collect usage data\" to be enabled.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
                VToggle(isOn: Binding(
                    get: { store.sendPerformanceReports },
                    set: { store.sendPerformanceReports = $0 }
                ))
                .disabled(!collectUsageData)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
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

    private func setCollectUsageData(_ enabled: Bool) async {
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
            if enabled {
                MetricKitManager.startSentry()
            } else {
                MetricKitManager.closeSentry()
            }
        } catch {
            // Revert the optimistic toggle on failure
            collectUsageData = !enabled
            loadError = "Could not save privacy setting: \(error.localizedDescription)"
        }
        isUpdating = false
    }
}

#Preview("SettingsPrivacyTab") {
    ZStack {
        VColor.background.ignoresSafeArea()
        SettingsPrivacyTab(daemonClient: nil, store: SettingsStore())
            .frame(width: 480)
            .padding()
    }
}
