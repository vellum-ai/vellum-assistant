import SwiftUI
import VellumAssistantLib

@main
struct VellumAssistantApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        // The Settings scene exists solely to host the .commands menu items
        // below.  It renders EmptyView — no actual content — but SwiftUI
        // still creates a managed NSWindow for it.  During activation-policy
        // transitions (.accessory → .regular) macOS can restore/show this
        // window, producing a "ghost" blank window that appears as a second
        // app instance.
        //
        // Mitigations (see AppDelegate):
        //  • Saved frame removed on every launch to prevent restoration.
        //  • NSWindow.allowsAutomaticWindowTabbing = false.
        //  • Policy transitions only happen synchronously on window close.
        //  • dismissSettingsGhostWindows() runs after each policy transition.
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
                Divider()
                Button("Send Logs to Vellum") {
                    appDelegate.sendLogsToSentry()
                }
                Divider()
                Button("Uninstall Vellum...") {
                    appDelegate.performUninstall()
                }
            }
            // Replace the default Settings menu item (which opens the SwiftUI
            // Settings scene window) with one that opens the in-app panel.
            CommandGroup(replacing: .appSettings) {
                Button("Settings...") {
                    appDelegate.showSettingsWindow(nil)
                }
                .keyboardShortcut(",", modifiers: .command)
            }
            // View menu: zoom shortcuts for discoverability.
            // The actual handling is done by event monitors (registerZoomMonitor)
            // which fire before the menu system. Zoom always applies so menu
            // consumption is fine.
            // Navigation shortcuts (Cmd+[/]) are NOT included here because
            // the menu system would consume the event even when the nav stack
            // is empty, breaking the event monitor's intentional pass-through
            // to the responder chain (e.g. text editors).
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
            }
        }
    }
}
