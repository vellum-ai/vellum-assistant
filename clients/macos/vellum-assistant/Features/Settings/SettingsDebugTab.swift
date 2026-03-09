import SwiftUI
@preconcurrency import Sentry
import VellumAssistantShared

/// Debug settings tab — provides buttons to trigger various Sentry event types
/// for validating that the Sentry DSN is receiving reports correctly.
/// Only visible when dev mode is enabled.
@MainActor
struct SettingsDebugTab: View {
    @ObservedObject var store: SettingsStore

    @State private var lastStatus: String?
    @State private var isSentryEnabled: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            sentryTestingSection
        }
        .onAppear {
            isSentryEnabled = UserDefaults.standard.object(forKey: "collectUsageDataEnabled") as? Bool ?? true
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
                        let event = Event(level: .error)
                        event.message = SentryMessage(formatted: "Sentry test error from Settings debug tab")
                        event.tags = ["source": "settings_debug"]
                        MetricKitManager.captureSentryEvent(event)
                        showStatus("Error event sent!")
                    }
                    Text("Captures a Sentry event with level .error")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                Divider().foregroundColor(VColor.divider)

                // Test warning
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Send Test Warning", style: .secondary) {
                        let event = Event(level: .warning)
                        event.message = SentryMessage(formatted: "Sentry test warning from Settings debug tab")
                        event.tags = ["source": "settings_debug"]
                        MetricKitManager.captureSentryEvent(event)
                        showStatus("Warning event sent!")
                    }
                    Text("Captures a Sentry event with level .warning")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                Divider().foregroundColor(VColor.divider)

                // Test message
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Send Test Message", style: .secondary) {
                        let event = Event(level: .info)
                        event.message = SentryMessage(formatted: "Sentry test message from Settings debug tab")
                        event.tags = ["source": "settings_debug"]
                        MetricKitManager.captureSentryEvent(event)
                        showStatus("Info message sent!")
                    }
                    Text("Captures a Sentry event with level .info")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }

                Divider().foregroundColor(VColor.divider)

                // Performance transaction
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VButton(label: "Test Performance Transaction", style: .secondary) {
                        MetricKitManager.sentrySerialQueue.async {
                            guard SentrySDK.isEnabled else {
                                DispatchQueue.main.async { showStatus("Sentry is disabled — transaction not sent.") }
                                return
                            }
                            let transaction = SentrySDK.startTransaction(
                                name: "settings-debug-test",
                                operation: "test.transaction"
                            )
                            transaction.finish()
                            DispatchQueue.main.async { showStatus("Performance transaction sent!") }
                        }
                    }
                    Text("Starts and finishes a Sentry transaction to validate tracing.")
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

    private func showStatus(_ message: String) {
        withAnimation { lastStatus = message }
        // Auto-dismiss after a few seconds
        DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
            withAnimation {
                if lastStatus == message { lastStatus = nil }
            }
        }
    }
}

#Preview("SettingsDebugTab") {
    ZStack {
        VColor.background.ignoresSafeArea()
        SettingsDebugTab(store: SettingsStore())
            .frame(width: 480)
            .padding()
    }
}
