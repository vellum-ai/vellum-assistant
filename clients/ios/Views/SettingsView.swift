#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

enum ConnectionMode: String, CaseIterable {
    case standalone = "Standalone"
    case connected = "Connected to Mac"
}

struct SettingsView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @AppStorage(UserDefaultsKeys.connectionMode) private var connectionMode: String = ConnectionMode.standalone.rawValue
    @AppStorage(UserDefaultsKeys.appearanceMode) private var appearanceMode: String = "system"

    var body: some View {
        NavigationStack {
            Form {
                Section("Connection Mode") {
                    Picker("Mode", selection: $connectionMode) {
                        ForEach(ConnectionMode.allCases, id: \.rawValue) { mode in
                            Text(mode.rawValue).tag(mode.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: connectionMode) { _, newMode in
                        switchClient(to: newMode)
                    }
                }

                if connectionMode == ConnectionMode.standalone.rawValue {
                    APIKeySection()
                } else {
                    DaemonConnectionSection()
                    IntegrationsSection()
                    TrustRulesSection()
                    SchedulesSection()
                    RemindersSection()
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
        }
    }

    private func switchClient(to mode: String) {
        clientProvider.client.disconnect()
        let newClient: any DaemonClientProtocol
        if mode == ConnectionMode.connected.rawValue {
            newClient = DaemonClient(config: .fromUserDefaults())
        } else {
            newClient = DirectClaudeClient()
        }
        clientProvider.client = newClient
        Task {
            do {
                try await clientProvider.client.connect()
            } catch {
                // Connection failed — sections will handle their own loading
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
    SettingsView()
        .environmentObject(ClientProvider(client: DirectClaudeClient()))
}
#endif
