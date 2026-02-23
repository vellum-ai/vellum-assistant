import SwiftUI
import VellumAssistantLib

@main
struct VellumAssistantApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        Settings {
            EmptyView()
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
            // Replace the default Settings menu item (which opens the SwiftUI
            // Settings scene window) with one that opens the in-app panel.
            CommandGroup(replacing: .appSettings) {
                Button("Settings...") {
                    appDelegate.showSettingsWindow(nil)
                }
                .keyboardShortcut(",", modifiers: .command)
            }
        }
    }
}
