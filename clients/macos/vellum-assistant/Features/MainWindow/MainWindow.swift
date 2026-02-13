import AppKit
import SwiftUI

@MainActor
final class MainWindow {
    private let daemonClient: DaemonClient
    private let ambientAgent: AmbientAgent
    private var window: NSWindow?
    let threadManager: ThreadManager
    let appsManager: AppsManager
    var onMicrophoneToggle: (() -> Void)?

    /// Whether the main window is currently visible on screen.
    var isVisible: Bool {
        window?.isVisible ?? false
    }

    /// The active ChatViewModel from the current thread, if any.
    var activeViewModel: ChatViewModel? {
        threadManager.activeViewModel
    }

    init(daemonClient: DaemonClient, ambientAgent: AmbientAgent) {
        self.daemonClient = daemonClient
        self.ambientAgent = ambientAgent
        self.threadManager = ThreadManager(daemonClient: daemonClient)
        self.appsManager = AppsManager(daemonClient: daemonClient)
    }

    func show() {
        // Reuse the existing window if one already exists
        if let existing = window {
            // Rebuild the SwiftUI view hierarchy so it picks up any
            // UserDefaults changes (e.g. assistantName set during onboarding replay)
            existing.contentViewController = NSHostingController(rootView: MainWindowView(threadManager: threadManager, appsManager: appsManager, daemonClient: daemonClient, ambientAgent: ambientAgent, onMicrophoneToggle: onMicrophoneToggle ?? {}))
            existing.makeKeyAndOrderFront(nil)
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let hostingController = NSHostingController(rootView: MainWindowView(threadManager: threadManager, appsManager: appsManager, daemonClient: daemonClient, ambientAgent: ambientAgent, onMicrophoneToggle: onMicrophoneToggle ?? {}))

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1366, height: 849),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        window.contentViewController = hostingController
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(VColor.background)
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 800, height: 600)

        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let w = min(1366, screenFrame.width)
        let h = min(849, screenFrame.height)
        window.setContentSize(NSSize(width: w, height: h))
        window.center()

        // Keep regular activation policy — the main window should appear in Dock and Cmd+Tab
        NSApp.setActivationPolicy(.regular)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        self.window = window
    }

    func close() {
        window?.close()
        window = nil
    }
}
