import SwiftUI

@main
struct VellumAssistantApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings {
            SettingsView(ambientAgent: appDelegate.ambientAgent)
        }
    }
}
