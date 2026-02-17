import AppKit
import SwiftUI
import VellumAssistantShared

/// A separate window that hosts the chat panel in pop-out mode.
/// Shares the same ThreadManager and MainWindowState as the main window
/// so message/session state is preserved when switching between docked
/// and popped-out chat.
@MainActor
final class ChatWindow {
    private var window: NSWindow?
    private var closeObserver: NSObjectProtocol?
    private let threadManager: ThreadManager
    private let windowState: MainWindowState
    private let ambientAgent: AmbientAgent
    private let onMicrophoneToggle: () -> Void
    /// Called when the user closes the pop-out window so the main window
    /// can revert to docked chat mode.
    private let onClose: () -> Void

    init(
        threadManager: ThreadManager,
        windowState: MainWindowState,
        ambientAgent: AmbientAgent,
        onMicrophoneToggle: @escaping () -> Void,
        onClose: @escaping () -> Void
    ) {
        self.threadManager = threadManager
        self.windowState = windowState
        self.ambientAgent = ambientAgent
        self.onMicrophoneToggle = onMicrophoneToggle
        self.onClose = onClose
    }

    var isVisible: Bool {
        window?.isVisible ?? false
    }

    func show() {
        if let existing = window {
            if existing.isMiniaturized {
                existing.deminiaturize(nil)
            }
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let chatPanel = ChatPanelView(
            threadManager: threadManager,
            windowState: windowState,
            ambientAgent: ambientAgent,
            onMicrophoneToggle: onMicrophoneToggle
        )

        let hostingController = NSHostingController(rootView: chatPanel)

        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let windowWidth: CGFloat = min(480, screenFrame.width * 0.35)
        let windowHeight: CGFloat = min(screenFrame.height * 0.7, 700)
        let windowRect = NSRect(
            x: screenFrame.maxX - windowWidth - 32,
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
        window.title = "Chat"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(VColor.chatBackground)
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 320, height: 400)
        window.setFrame(windowRect, display: false)
        window.setFrameAutosaveName("ChatPopOutWindow")

        // Observe the window closing to revert to docked mode
        closeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.onClose()
                self?.window = nil
            }
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        self.window = window
    }

    func close() {
        if let observer = closeObserver {
            NotificationCenter.default.removeObserver(observer)
            closeObserver = nil
        }
        window?.close()
        window = nil
    }
}
