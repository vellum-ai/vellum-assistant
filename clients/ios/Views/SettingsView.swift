#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct SettingsView: View {
    @Bindable var authManager: AuthManager
    /// Shared conversation store — forwarded to DeveloperSettingsSection so its diagnostics
    /// (last fetch error, etc.) reflect the same store the Chats view reads from.
    var conversationStore: IOSConversationStore

    var body: some View {
        NavigationStack {
            Form {
                AccountSection(authManager: authManager)

                Section("About") {
                    LabeledContent("Version", value: Bundle.main.appVersion)
                }

                // Developer tooling: hidden in production, visible in non-production
                // deployments, or via the secret 5-tap gesture on the version row
                // (TODO: LUM-980). Gated by runtime environment rather than `#if DEBUG`
                // per AGENTS.md — a debug build pointed at staging is still staging.
                if VellumEnvironment.current != .production {
                    Section("Developer") {
                        NavigationLink {
                            DeveloperSettingsSection(authManager: authManager, conversationStore: conversationStore)
                        } label: {
                            Label { Text("Developer") } icon: { VIconView(.bug, size: 14) }
                        }
                    }
                }
            }
            .navigationTitle("Settings")
        }
    }
}

// MARK: - Account Section

struct AccountSection: View {
    @Bindable var authManager: AuthManager

    var body: some View {
        Section("Account") {
            if authManager.isLoading {
                HStack {
                    Text("Checking session...")
                    Spacer()
                    ProgressView()
                }
            } else if let user = authManager.currentUser {
                if let email = user.email {
                    LabeledContent("Email", value: email)
                }
                if let display = user.display {
                    LabeledContent("Name", value: display)
                }
                Button("Log Out", role: .destructive) {
                    Task {
                        await authManager.logout()
                    }
                }
            } else if authManager.isValidationFailed {
                HStack {
                    Text("Reconnecting to Vellum...")
                    Spacer()
                    ProgressView()
                }
                Button("Retry") {
                    Task { await authManager.checkSession() }
                }
            } else {
                Button {
                    Task { await authManager.startWorkOSLogin() }
                } label: {
                    if authManager.isSubmitting {
                        HStack {
                            Text("Signing in...")
                            Spacer()
                            ProgressView()
                        }
                    } else {
                        Text("Log in with Vellum")
                    }
                }
                .disabled(authManager.isSubmitting)
            }

            if let error = authManager.errorMessage {
                Text(error)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
        }
    }
}

extension Bundle {
    var appVersion: String {
        infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }
}
#endif
