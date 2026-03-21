#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct SettingsView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @Bindable var authManager: AuthManager
    @AppStorage(UserDefaultsKeys.developerModeEnabled) private var developerModeEnabled: Bool = false
    @Binding var navigateToConnect: Bool
    @State private var versionTapCount: Int = 0
    @State private var contactsStore: ContactsStore?
    @State private var channelTrustStore: ChannelTrustStore?
    /// Shared conversation store — passed through so PrivateConversationsSection can show and
    /// manage private conversations without creating a second store that races on UserDefaults.
    var conversationStore: IOSConversationStore

    /// Lazily builds the Channels & Guardian destination using the
    /// pre-created stores from `@State` properties.
    @ViewBuilder
    private var channelsGuardianDestination: some View {
        if let trustStore = channelTrustStore, let contacts = contactsStore {
            ChannelsGuardianSection(channelTrustStore: trustStore, contactsStore: contacts)
        } else {
            Text("Not connected")
                .foregroundStyle(.secondary)
        }
    }

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
                    NavigationLink {
                        ModelsServicesSection()
                    } label: {
                        Label { Text("Models & Services") } icon: { VIconView(.cpu, size: 14) }
                    }
                    NavigationLink {
                        TwilioSettingsSection()
                    } label: {
                        Label { Text("Twilio") } icon: { VIconView(.phone, size: 14) }
                    }
                    NavigationLink {
                        IntegrationsSection()
                    } label: {
                        Label { Text("Integrations") } icon: { VIconView(.link, size: 14) }
                    }
                    NavigationLink {
                        channelsGuardianDestination
                    } label: {
                        Label { Text("Channels & Guardian") } icon: { VIconView(.shieldCheck, size: 14) }
                    }
                    NavigationLink {
                        SchedulesSection()
                    } label: {
                        Label { Text("Scheduled Tasks") } icon: { VIconView(.clock, size: 14) }
                    }
                    NavigationLink {
                        TrustRulesSection()
                    } label: {
                        Label { Text("Trust Rules") } icon: { VIconView(.shieldAlert, size: 14) }
                    }
                    NavigationLink {
                        RemindersSection()
                    } label: {
                        Label { Text("Reminders") } icon: { VIconView(.bell, size: 14) }
                    }
                    NavigationLink {
                        PrivateConversationsSection(store: conversationStore)
                    } label: {
                        Label { Text("Private Conversations") } icon: { VIconView(.shield, size: 14) }
                    }
                    NavigationLink {
                        MediaEmbedSettingsSection()
                    } label: {
                        Label { Text("Media Embeds") } icon: { VIconView(.video, size: 14) }
                    }
                    NavigationLink {
                        VoiceSettingsSection()
                    } label: {
                        Label { Text("Voice") } icon: { VIconView(.audioWaveform, size: 14) }
                    }
                }

                NavigationLink {
                    AppearanceSection()
                } label: {
                    Label { Text("Appearance") } icon: { VIconView(.paintbrush, size: 14) }
                }

                Section("Permissions") {
                    NavigationLink {
                        PrivacySection()
                    } label: {
                        Label { Text("Privacy") } icon: { VIconView(.eye, size: 14) }
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
                            DeveloperSettingsSection()
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
            .task(id: "\(clientProvider.clientGeneration)-\(clientProvider.isConnected)") {
                guard clientProvider.isConnected else {
                    contactsStore = nil
                    channelTrustStore = nil
                    return
                }
                if let daemon = clientProvider.client as? DaemonClient {
                    let contacts = ContactsStore(daemonClient: daemon, eventStreamClient: clientProvider.eventStreamClient)
                    contactsStore = contacts
                    channelTrustStore = ChannelTrustStore(daemonClient: daemon, contactsStore: contacts)
                }
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
                    .font(VFont.caption)
                    .foregroundColor(VColor.systemNegativeStrong)
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
