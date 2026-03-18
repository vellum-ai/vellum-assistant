#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Appearance settings screen — theme selection and display preferences.
/// Mirrors the macOS SettingsAppearanceTab, adapted for iOS Form-based navigation.
struct AppearanceSection: View {
    @AppStorage(UserDefaultsKeys.appearanceMode) private var appearanceMode: String = "system"

    var body: some View {
        Form {
            Section {
                Picker("Theme", selection: $appearanceMode) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
                .pickerStyle(.segmented)
            } header: {
                Text("Color Scheme")
            } footer: {
                Text("\"System\" follows your device's Light/Dark Mode setting.")
            }
        }
        .navigationTitle("Appearance")
        .navigationBarTitleDisplayMode(.inline)
    }
}
#endif
