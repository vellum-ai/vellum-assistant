import AppKit
import SwiftUI
import VellumAssistantShared

/// A borderless, floating NSPanel that hosts the Quick Chat text editor.
/// Appears centered on the active screen with a vibrancy/blur background.
/// Dismisses itself when it resigns key window status.
@MainActor
final class QuickChatPanel {
    private var panel: NSPanel?
    private var resignObserver: Any?

    /// Callback invoked when the user submits a message.
    var onSubmit: ((String) -> Void)?

    func show() {
        if let existing = panel {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let view = QuickChatView(
            onSubmit: { [weak self] message in
                self?.onSubmit?(message)
                self?.dismiss()
            },
            onDismiss: { [weak self] in
                self?.dismiss()
            }
        )

        let hostingController = NSHostingController(rootView: view)

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 60),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )

        panel.contentViewController = hostingController
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        // Center on the active screen
        centerOnScreen(panel)

        // Become key so the text editor receives focus
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Dismiss when the panel loses focus
        resignObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.dismiss()
            }
        }

        self.panel = panel
    }

    func dismiss() {
        if let resignObserver {
            NotificationCenter.default.removeObserver(resignObserver)
        }
        resignObserver = nil
        panel?.close()
        panel = nil
    }

    var isVisible: Bool {
        panel?.isVisible ?? false
    }

    // MARK: - Private

    private func centerOnScreen(_ panel: NSPanel) {
        let screen = NSScreen.main ?? NSScreen.screens.first
        guard let screenFrame = screen?.visibleFrame else { return }

        // Let the hosting controller size the panel to fit the content
        if let fittingSize = panel.contentView?.fittingSize {
            let width = max(fittingSize.width, 400)
            let height = fittingSize.height
            let x = screenFrame.midX - width / 2
            // Position slightly above center (like Spotlight)
            let y = screenFrame.midY + screenFrame.height * 0.1
            panel.setFrame(
                NSRect(x: x, y: y, width: width, height: height),
                display: true
            )
        } else {
            panel.center()
        }
    }
}
