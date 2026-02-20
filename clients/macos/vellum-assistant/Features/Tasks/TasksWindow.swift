import AppKit
import VellumAssistantShared
import SwiftUI

/// Standalone window that displays the task queue independently of the main window.
/// Follows the same pattern as ComponentGalleryWindow and OnboardingWindow.
@MainActor
final class TasksWindow {
    private var window: NSWindow?
    private let daemonClient: DaemonClient
    /// Called when the user taps "Open in Chat" — creates the thread and
    /// brings the main window forward.
    var onOpenInChat: ((String, String, String) -> Void)?

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
    }

    func show() {
        if let existing = window {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            // Force a data refresh so the view doesn't show stale items
            try? daemonClient.sendWorkItemsList()
            return
        }

        let hostingController = NSHostingController(
            rootView: TasksWindowView(daemonClient: daemonClient, onOpenInChat: onOpenInChat)
        )

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 550),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )

        window.contentViewController = hostingController
        window.title = "Tasks"
        window.backgroundColor = NSColor(VColor.background)
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 320, height: 400)

        window.setContentSize(NSSize(width: 420, height: 550))
        window.center()

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        self.window = window
    }

    var isVisible: Bool {
        window?.isVisible ?? false
    }

    func close() {
        window?.close()
        window = nil
    }
}
