import Sentry
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

    @State private var isReportSheetPresented: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            diagnosticsSection
            reportProblemSection
        }
        .onAppear {
            Task { await loadPrivacyFlags() }
        }
        .sheet(isPresented: $isReportSheetPresented) {
            ReportProblemSheet(isPresented: $isReportSheetPresented)
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
                        .foregroundColor(VColor.textSecondary)
                    Text("Send anonymised performance metrics (hang rate, scroll speed) to help us improve responsiveness. No personal data or message content is included.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
                VToggle(isOn: Binding(
                    get: { store.sendPerformanceReports },
                    set: { store.sendPerformanceReports = $0 }
                ))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Report a Problem Section

    private var reportProblemSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Feedback")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Report a Problem")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                    Text("Send a manual report to the development team. Always available, even when automatic reporting is off.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                Spacer()
                Button("Report a Problem") {
                    isReportSheetPresented = true
                }
                .buttonStyle(.bordered)
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
        } catch {
            // Revert the optimistic toggle on failure
            collectUsageData = !enabled
            loadError = "Could not save privacy setting: \(error.localizedDescription)"
        }
        isUpdating = false
    }
}

// MARK: - Report a Problem Sheet

/// Sheet that lets the user write a description and send a manual Sentry report.
/// The report is always sent regardless of the auto-reporting opt-out setting.
@MainActor
private struct ReportProblemSheet: View {
    @Binding var isPresented: Bool
    @State private var userDescription: String = ""
    @State private var isSending: Bool = false
    @State private var didSend: Bool = false
    @State private var dismissTask: Task<Void, Never>?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            Text("Report a Problem")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            Text("Describe what happened (optional)")
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)

            TextEditor(text: $userDescription)
                .font(VFont.body)
                .frame(minHeight: 120)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(VColor.divider, lineWidth: 1)
                )

            if didSend {
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                    Text("Report sent. Thank you!")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                }
            }

            HStack {
                Spacer()
                Button("Cancel") {
                    dismissTask?.cancel()
                    isPresented = false
                }
                .buttonStyle(.bordered)
                .disabled(isSending)

                Button("Send Report") {
                    sendReport()
                }
                .buttonStyle(.borderedProminent)
                .disabled(isSending || didSend)
            }
        }
        .padding(VSpacing.lg)
        .frame(width: 440)
    }

    private func sendReport() {
        isSending = true
        // Capture Sendable (value type) copies before hopping off the main actor.
        let message = userDescription.isEmpty ? "Manual problem report" : userDescription
        let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        // Run Sentry operations on a background thread so SentrySDK.flush(timeout:)
        // — which can block for up to 5 seconds — never freezes the main thread.
        // If the user opted out, Sentry is closed by checkAndApplyPrivacyFlag();
        // start it temporarily, flush to ensure delivery, then close to restore
        // the opted-out state so no automatic events slip through afterward.
        Task.detached {
            let event = Event(level: .info)
            event.message = SentryMessage(formatted: message)
            event.tags = ["source": "manual_report", "app_version": appVersion]
            // Use the shared serial queue to serialise SDK lifecycle changes and
            // to ensure the user's crash-reporting opt-out is honoured — automatic
            // capture is disabled when Sentry is temporarily restarted so only
            // this explicit capture(event:) call sends data.
            MetricKitManager.sentrySerialQueue.sync {
                let wasDisabled = !SentrySDK.isEnabled
                if wasDisabled {
                    SentrySDK.start { options in
                        options.dsn = "https://db2d38a082e4ee35eeaea08c44b376ec@o4504590528675840.ingest.us.sentry.io/4510874712276992"
                        options.sendDefaultPii = false
                        // Disable crash capture and session tracking so the temporary
                        // restart only sends the explicit capture(event:) below.
                        options.enableCrashHandler = false
                        options.enableAutoSessionTracking = false
                    }
                }
                SentrySDK.capture(event: event)
                if wasDisabled {
                    SentrySDK.flush(timeout: 5)
                    SentrySDK.close()
                }
            }
            await MainActor.run {
                isSending = false
                didSend = true
                // Dismiss automatically after a short delay so the user can see the confirmation.
                dismissTask?.cancel()
                dismissTask = Task {
                    try? await Task.sleep(nanoseconds: 1_200_000_000)
                    guard !Task.isCancelled else { return }
                    isPresented = false
                }
            }
        }
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

#Preview("ReportProblemSheet") {
    ReportProblemSheet(isPresented: .constant(true))
        .padding()
}
