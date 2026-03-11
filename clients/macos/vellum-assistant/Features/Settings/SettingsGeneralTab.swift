import SwiftUI
import VellumAssistantShared

/// General settings tab — account/platform sign-in card followed by appearance settings.
@MainActor
struct SettingsGeneralTab: View {
    @ObservedObject var store: SettingsStore
    var daemonClient: DaemonClient?
    var authManager: AuthManager
    var onClose: () -> Void

    // -- Account / Vellum section state --
    @State private var platformUrlText: String = ""
    @FocusState private var isPlatformUrlFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            accountSection
            SettingsAppearanceTab(store: store)
        }
        .onAppear {
            Task { await authManager.checkSession() }
            store.refreshPlatformConfig()
            platformUrlText = store.platformBaseUrl
        }
        .onChange(of: store.platformBaseUrl) { _, newValue in
            if !isPlatformUrlFocused {
                platformUrlText = newValue
            }
        }
    }

    // MARK: - Account Section

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Account & Platform")
                .font(VFont.sectionTitle)
                .foregroundColor(VColor.textPrimary)

            Text("Platform URL")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.textSecondary)

            HStack(spacing: VSpacing.sm) {
                TextField("https://platform.vellum.ai", text: $platformUrlText)
                    .vInputStyle()
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .focused($isPlatformUrlFocused)

                VButton(label: "Save", style: .primary, size: .medium, isDisabled: platformUrlText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) {
                    store.savePlatformBaseUrl(platformUrlText)
                    isPlatformUrlFocused = false
                }
            }

            Divider().background(VColor.surfaceBorder)

            Text("Sign in to Your Account")
                .font(VFont.inputLabel)
                .foregroundColor(VColor.textSecondary)

            if authManager.isLoading {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Checking...")
                        .font(VFont.body)
                        .foregroundColor(VColor.textSecondary)
                }
            } else if authManager.currentUser != nil {
                VButton(label: "Log Out", style: .danger, size: .medium) {
                    Task { await authManager.logout() }
                }
            } else {
                VButton(
                    label: authManager.isSubmitting ? "Signing in..." : "Sign In",
                    style: .primary,
                    size: .medium,
                    isDisabled: authManager.isSubmitting
                ) {
                    Task { await authManager.startWorkOSLogin() }
                }
            }

            if let error = authManager.errorMessage {
                Text(error)
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceSubtle)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
