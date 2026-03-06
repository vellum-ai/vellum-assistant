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
            // View menu: zoom and navigation shortcuts.
            // The actual handling is done by event monitors (registerZoomMonitor,
            // registerNavigationMonitor) which fire before the menu system.
            // These items exist for discoverability — users see the shortcuts
            // in the View menu even though the event monitors do the work.
            CommandGroup(replacing: .toolbar) {
                Button("Zoom In") {
                    appDelegate.performZoomIn()
                }
                .keyboardShortcut("=", modifiers: .command)
                Button("Zoom Out") {
                    appDelegate.performZoomOut()
                }
                .keyboardShortcut("-", modifiers: .command)
                Button("Actual Size") {
                    appDelegate.performZoomReset()
                }
                .keyboardShortcut("0", modifiers: .command)
                Divider()
                Button("Back") {
                    appDelegate.performNavigateBack()
                }
                .keyboardShortcut("[", modifiers: .command)
                Button("Forward") {
                    appDelegate.performNavigateForward()
                }
                .keyboardShortcut("]", modifiers: .command)
            }
        }
    }
}
