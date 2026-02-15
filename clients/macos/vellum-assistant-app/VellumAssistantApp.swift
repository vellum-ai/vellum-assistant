import SwiftUI
import VellumAssistantLib

@main
struct VellumAssistantApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings {
            SettingsView(store: appDelegate.services.settingsStore, ambientAgent: appDelegate.services.ambientAgent, daemonClient: appDelegate.services.daemonClient)
        }
    }
}
