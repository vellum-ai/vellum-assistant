import SwiftUI
@preconcurrency import Sentry
import VellumAssistantShared

/// Sentry testing tab — provides buttons to trigger various Sentry event types
/// for validating that the Sentry DSN is receiving reports correctly.
/// Only visible when the `sentry_testing_enabled` feature flag is on.
@MainActor
struct SettingsDebugTab: View {
    @State private var lastStatus: String?
    @State private var dismissTask: Task<Void, Never>?
    @State private var isSentryEnabled: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            sentryTestingSection
        }
        .onAppear {
            isSentryEnabled = UserDefaults.standard.object(forKey: "collectUsageDataEnabled") as? Bool ?? true
        }
        .onDisappear {
            dismissTask?.cancel()
        }
    }

    // MARK: - Sentry Testing Section

    private var sentryTestingSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Sentry Testing")
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.textPrimary)

                Text("Trigger test events to validate that Sentry is receiving reports from this app.")
                    .font(VFont.sectionDescription)
                    .foregroundColor(VColor.textMuted)
            }

            if !isSentryEnabled {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.triangleAlert, size: 12)
                        .foregroundColor(VColor.warning)
                    Text("Usage data collection is disabled. Non-fatal events will be silently dropped unless you enable \"Collect usage data\" in the Privacy tab.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.warning)
                }
            }

            if let status = lastStatus {
                HStack(spacing: VSpacing.xs) {
                    VIconView(.circleCheck, size: 12)
                        .foregroundColor(VColor.success)
                    Text(status)
                        .font(VFont.caption)
                        .foregroundColor(VColor.success)
                }
                .transition(.opacity)
            }

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                // Fatal crash
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Trigger Fatal Crash", style: .danger) {
                        fatalError("Sentry test crash")
                    }
                    Text("Calls fatalError() — will terminate the app immediately.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                Divider().foregroundColor(VColor.divider)

                // Test error
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Send Test Error", style: .secondary) {
                        sendTestEvent(level: .error, label: "error")
                    }
                    Text("Captures a Sentry event with level .error")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                Divider().foregroundColor(VColor.divider)

                // Test warning
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Send Test Warning", style: .secondary) {
                        sendTestEvent(level: .warning, label: "warning")
                    }
                    Text("Captures a Sentry event with level .warning")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                Divider().foregroundColor(VColor.divider)

                // Test message
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Send Test Message", style: .secondary) {
                        sendTestEvent(level: .info, label: "info message")
                    }
                    Text("Captures a Sentry event with level .info")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                Divider().foregroundColor(VColor.divider)

                // Performance transaction
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Test Performance Transaction", style: .secondary) {
                        guard isSentryEnabled else {
                            showStatus("Sentry is disabled — transaction not sent.")
                            return
                        }
                        MetricKitManager.sentrySerialQueue.async {
                            guard SentrySDK.isEnabled else {
                                Task { @MainActor in showStatus("Sentry is disabled — transaction not sent.") }
                                return
                            }
                            let transaction = SentrySDK.startTransaction(
                                name: "settings-debug-test",
                                operation: "test.transaction"
                            )
                            transaction.finish()
                            Task { @MainActor in
                                showStatus("Transaction finished (10% sample rate — may not appear in Sentry).")
                            }
                        }
                    }
                    Text("Starts and finishes a Sentry transaction. Only ~10% are sampled and sent.")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(VSpacing.lg)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Helpers

    private func sendTestEvent(level: SentryLevel, label: String) {
        guard isSentryEnabled else {
            showStatus("Sentry is disabled — \(label) not sent.")
            return
        }
        let event = Event(level: level)
        event.message = SentryMessage(formatted: "Sentry test \(label) from Settings debug tab")
        event.tags = ["source": "settings_debug"]
        MetricKitManager.captureSentryEvent(event)
        showStatus("\(label.capitalized) event sent!")
    }

    private func showStatus(_ message: String) {
        dismissTask?.cancel()
        withAnimation { lastStatus = message }
        dismissTask = Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            guard !Task.isCancelled else { return }
            withAnimation {
                if lastStatus == message { lastStatus = nil }
            }
        }
    }
}

#Preview("SettingsDebugTab") {
    ZStack {
        VColor.background.ignoresSafeArea()
        SettingsDebugTab()
            .frame(width: 480)
            .padding()
    }
}
