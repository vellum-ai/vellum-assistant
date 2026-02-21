import SwiftUI
import VellumAssistantLib

@main
struct VellumAssistantApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings {
            SettingsView(store: appDelegate.services.settingsStore, daemonClient: appDelegate.services.daemonClient)
        }
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button("About Vellum") {
                    appDelegate.showAboutPanel()
                }
                Button("Check for Updates...") {
                    appDelegate.updateManager.checkForUpdates()
                }
                .disabled(!appDelegate.updateManager.canCheckForUpdates)
            }
        }
    }
}
