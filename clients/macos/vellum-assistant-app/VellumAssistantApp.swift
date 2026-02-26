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

            // Define zoom commands through SwiftUI's command system so they are
            // consistently attached to the native View menu lifecycle.
            CommandGroup(before: .windowSize) {
                Button("Conversation Zoom In") {
                    appDelegate.handleConversationZoomIn()
                }
                .keyboardShortcut("+", modifiers: .command)
                .disabled(!appDelegate.isConversationZoomEnabled)

                Button("Conversation Zoom Out") {
                    appDelegate.handleConversationZoomOut()
                }
                .keyboardShortcut("-", modifiers: .command)
                .disabled(!appDelegate.isConversationZoomEnabled)

                Button("Conversation Actual Size") {
                    appDelegate.handleConversationZoomReset()
                }
                .keyboardShortcut("0", modifiers: .command)
                .disabled(!appDelegate.isConversationZoomEnabled)

                Divider()

                Button("Window Zoom In") {
                    appDelegate.handleWindowZoomIn()
                }
                .keyboardShortcut("+", modifiers: [.command, .option])

                Button("Window Zoom Out") {
                    appDelegate.handleWindowZoomOut()
                }
                .keyboardShortcut("-", modifiers: [.command, .option])

                Button("Window Actual Size") {
                    appDelegate.handleWindowZoomReset()
                }
                .keyboardShortcut("0", modifiers: [.command, .option])
            }
        }
    }
}
