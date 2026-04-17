#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct SettingsView: View {
    @Bindable var authManager: AuthManager
    @AppStorage(UserDefaultsKeys.developerModeEnabled) private var developerModeEnabled: Bool = false
    @Binding var navigateToConnect: Bool
    @State private var versionTapCount: Int = 0
    /// Shared conversation store — forwarded to DeveloperSettingsSection so its diagnostics
    /// (last fetch error, etc.) reflect the same store the Chats view reads from.
    var conversationStore: IOSConversationStore

    var body: some View {
        NavigationStack {
            Form {
                // Account section hidden until platform.vellum.ai is deployed.
                // Only show if the user is already authenticated (e.g. from a
                // previous session) so they can see their info and log out.
                if authManager.isAuthenticated {
                    AccountSection(authManager: authManager)
                }

                Section {
                    NavigationLink {
                        DaemonConnectionSection(authManager: authManager)
                    } label: {
                        Label { Text("Connect") } icon: { VIconView(.monitor, size: 14) }
                    }
                }

                Section("About") {
                    // Tapping the version label 7 times unlocks the developer toggle.
                    // This keeps the feature invisible to regular users while remaining
                    // accessible to developers without a build-time flag.
                    LabeledContent("Version", value: Bundle.main.appVersion)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            versionTapCount += 1
                            if versionTapCount >= 7 {
                                developerModeEnabled = true
                                versionTapCount = 0
                            }
                        }
                }

                if developerModeEnabled {
                    Section("Developer") {
                        Toggle("Developer Mode", isOn: $developerModeEnabled)
                        NavigationLink {
                            DeveloperSettingsSection(authManager: authManager, conversationStore: conversationStore)
                        } label: {
                            Label { Text("Debug Panel") } icon: { VIconView(.bug, size: 14) }
                        }
                    }
                }
            }
            .navigationTitle("Settings")
            .navigationDestination(isPresented: $navigateToConnect) {
                DaemonConnectionSection(authManager: authManager)
            }
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
