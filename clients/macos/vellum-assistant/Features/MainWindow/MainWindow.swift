import AppKit
import VellumAssistantShared
import SwiftUI

@MainActor
final class MainWindow {
    private let daemonClient: DaemonClient
    private let ambientAgent: AmbientAgent
    private var window: NSWindow?
    let threadManager: ThreadManager
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
    }

    func show() {
        // Reuse the existing window if one already exists
        if let existing = window {
            // Rebuild the SwiftUI view hierarchy so it picks up any
            // UserDefaults changes (e.g. assistantName set during onboarding replay)
            existing.contentViewController = NSHostingController(rootView: MainWindowView(threadManager: threadManager, daemonClient: daemonClient, ambientAgent: ambientAgent, onMicrophoneToggle: onMicrophoneToggle ?? {}))
            existing.makeKeyAndOrderFront(nil)
            NSApp.setActivationPolicy(.regular)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let hostingController = NSHostingController(rootView: MainWindowView(threadManager: threadManager, daemonClient: daemonClient, ambientAgent: ambientAgent, onMicrophoneToggle: onMicrophoneToggle ?? {}))

        let screenFrame = NSScreen.main?.visibleFrame ?? NSScreen.screens.first?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let windowWidth = min(1100.0, screenFrame.width * 0.75)
        let windowHeight = min(750.0, screenFrame.height * 0.75)
        let windowRect = NSRect(
            x: screenFrame.midX - windowWidth / 2,
            y: screenFrame.midY - windowHeight / 2,
            width: windowWidth,
            height: windowHeight
        )

        let window = NSWindow(
            contentRect: windowRect,
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
