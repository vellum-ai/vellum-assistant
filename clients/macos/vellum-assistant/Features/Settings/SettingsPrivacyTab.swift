import SwiftUI
import VellumAssistantShared

/// Privacy settings tab — lets the user control usage analytics and
/// crash/error diagnostics independently.
@MainActor
struct SettingsPrivacyTab: View {
    var daemonClient: DaemonClient?
    @ObservedObject var store: SettingsStore

    // Identity editing state
    @State private var isEditingIdentity: Bool = false
    @State private var editingName: String = ""
    @State private var editingEmail: String = ""

    var body: some View {
        VStack(spacing: VSpacing.lg) {
            identitySection

            Text("This information is attached to crash reports and log submissions to help us respond to your issues.")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, VSpacing.xs)

            privacySection
        }
    }

    // MARK: - Identity Section

    private var identitySection: some View {
        SettingsCard(title: "Identity") {
            if isEditingIdentity {
                identityEditingView
            } else {
                identityDisplayView
            }
        }
    }

    private var identityDisplayView: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Name")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                    Text(store.userDisplayName.isEmpty ? "Not set" : store.userDisplayName)
                        .font(VFont.body)
                        .foregroundColor(store.userDisplayName.isEmpty ? VColor.contentTertiary : VColor.contentSecondary)
                }
                Spacer()
            }

            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Email")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                    Text(store.userEmail.isEmpty ? "Not set" : store.userEmail)
                        .font(VFont.body)
                        .foregroundColor(store.userEmail.isEmpty ? VColor.contentTertiary : VColor.contentSecondary)
                }
                Spacer()
            }

            HStack {
                Spacer()
                VButton(label: "Edit", style: .outlined) {
                    editingName = store.userDisplayName
                    editingEmail = store.userEmail
                    isEditingIdentity = true
                }
            }
        }
    }

    private var identityEditingView: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Name")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                VTextField(placeholder: "Your name", text: $editingName)
            }

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("Email")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                VTextField(placeholder: "your@email.com", text: $editingEmail)
            }

            HStack {
                Spacer()
                VButton(label: "Cancel", style: .outlined) {
                    isEditingIdentity = false
                }
                VButton(label: "Save", style: .primary) {
                    store.userDisplayName = editingName
                    store.userEmail = editingEmail
                    SentryDeviceInfo.configureSentryScope()
                    isEditingIdentity = false
                }
            }
        }
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
