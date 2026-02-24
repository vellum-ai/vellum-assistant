#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct SettingsView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @Bindable var authManager: AuthManager
    @AppStorage(UserDefaultsKeys.appearanceMode) private var appearanceMode: String = "system"
    @Binding var navigateToConnect: Bool

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
                        DaemonConnectionSection()
                    } label: {
                        Label("Connect", systemImage: "desktopcomputer")
                    }
                    NavigationLink {
                        TwilioSettingsSection()
                    } label: {
                        Label("Twilio", systemImage: "phone")
                    }
                    NavigationLink {
                        IntegrationsSection()
                    } label: {
                        Label("Integrations", systemImage: "link")
                    }
                    NavigationLink {
                        SchedulesSection()
                    } label: {
                        Label("Scheduled Tasks", systemImage: "clock")
                    }
                    NavigationLink {
                        TrustRulesSection()
                    } label: {
                        Label("Trust Rules", systemImage: "shield.lefthalf.filled")
                    }
                    NavigationLink {
                        RemindersSection()
                    } label: {
                        Label("Reminders", systemImage: "bell")
                    }
                    NavigationLink {
                        IOSParentalControlSection()
                    } label: {
                        Label("Parental Controls", systemImage: "lock.shield")
                    }
                    NavigationLink {
                        PrivateThreadsSection(daemonClient: clientProvider.client)
                    } label: {
                        Label("Private Threads", systemImage: "lock.shield.fill")
                    }
                }

                Section("Appearance") {
                    Picker("Theme", selection: $appearanceMode) {
                        Text("System").tag("system")
                        Text("Light").tag("light")
                        Text("Dark").tag("dark")
                    }
                    .pickerStyle(.segmented)
                }

                Section("Permissions") {
                    PermissionRowView(permission: .microphone)
                    PermissionRowView(permission: .speechRecognition)
                }

                Section("About") {
                    LabeledContent("Version", value: Bundle.main.appVersion)
                }
            }
            .navigationTitle("Settings")
            .navigationDestination(isPresented: $navigateToConnect) {
                DaemonConnectionSection()
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
                    Task { await authManager.logout() }
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
                    .font(VFont.caption)
                    .foregroundColor(VColor.error)
            }
        }
    }
}

extension Bundle {
    var appVersion: String {
        infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }
}

#Preview {
    SettingsView(authManager: AuthManager(), navigateToConnect: .constant(false))
        .environmentObject(ClientProvider(client: DaemonClient(config: .fromUserDefaults())))
}
#endif
