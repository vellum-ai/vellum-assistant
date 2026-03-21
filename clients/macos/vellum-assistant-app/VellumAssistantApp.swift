import SwiftUI
import VellumAssistantLib

@main
struct VellumAssistantApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    private var appName: String { AppDelegate.appName }

    var body: some Scene {
        // The Settings scene exists solely to host the .commands menu items
        // below.  It renders EmptyView — no actual content — but SwiftUI
        // still creates a managed NSWindow for it.  During activation-policy
        // transitions (e.g. .accessory → .regular on disconnect/reconnect)
        // macOS can restore/show this window, producing a "ghost" blank
        // window.
        //
        // Mitigations (see AppDelegate):
        //  • Saved frame removed on every launch to prevent restoration.
        //  • NSWindow.allowsAutomaticWindowTabbing = false.
        //  • dismissSettingsGhostWindows() runs after each policy transition.
        Settings {
            EmptyView()
        }
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button("About \(appName)") {
                    appDelegate.showAboutPanel()
                }
            }
            // Replace the auto-generated Hide/Quit items so they always
            // say "Vellum" instead of the bundle display name (which may
            // be a custom dock label like the assistant's name).
            CommandGroup(replacing: .appVisibility) {
                Button("Hide \(appName)") {
                    NSApp.hide(nil)
                }
                .keyboardShortcut("h", modifiers: .command)
                Button("Hide Others") {
                    NSApp.hideOtherApplications(nil)
                }
                .keyboardShortcut("h", modifiers: [.command, .option])
                Button("Show All") {
                    NSApp.unhideAllApplications(nil)
                }
            }
            CommandGroup(replacing: .appTermination) {
                Button("Quit \(appName)") {
                    NSApp.terminate(nil)
                }
                .keyboardShortcut("q", modifiers: .command)
            }
            // Replace the default Settings menu item (which opens the SwiftUI
            // Settings scene window) with one that opens the in-app panel.
            CommandGroup(replacing: .appSettings) {
                Button("Settings...") {
                    appDelegate.showSettingsWindow(nil)
                }
                .keyboardShortcut(",", modifiers: .command)
                if appDelegate.authManager.isAuthenticated {
                    Button("Sign Out") {
                        appDelegate.performLogout()
                    }
                }
            }
            CommandGroup(replacing: .help) {
                Button("Documentation") {
                    NSWorkspace.shared.open(URL(string: "https://vellum.ai/docs?utm_source=macos-app&utm_medium=help-menu")!)
                }
                Button("Discord Community") {
                    NSWorkspace.shared.open(URL(string: "https://www.vellum.ai/community?utm_source=macos-app&utm_medium=help-menu")!)
                }
                Divider()
                Button("Share Feedback") {
                    appDelegate.sendLogsToSentry()
                }
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
