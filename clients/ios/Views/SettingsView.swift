#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct SettingsView: View {
    @EnvironmentObject var clientProvider: ClientProvider
    @AppStorage(UserDefaultsKeys.appearanceMode) private var appearanceMode: String = "system"

    var body: some View {
        NavigationStack {
            Form {
                DaemonConnectionSection()
                IntegrationsSection()
                TrustRulesSection()
                SchedulesSection()
                RemindersSection()

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
}

extension Bundle {
    var appVersion: String {
        infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
    }
}

#Preview {
    SettingsView()
        .environmentObject(ClientProvider(client: DaemonClient(config: .fromUserDefaults())))
}
#endif
