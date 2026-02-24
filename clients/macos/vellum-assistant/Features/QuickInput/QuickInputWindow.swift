import AppKit
import SwiftUI
import VellumAssistantShared

/// Borderless NSPanel subclass that can become key window.
/// Without this override, borderless windows refuse key status
/// and SwiftUI TextField won't accept keyboard input.
private class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// A borderless, floating NSPanel that hosts the Quick Input text field.
/// Appears centered on the active screen, slightly above center (Spotlight-style).
/// Dismisses itself when it resigns key window status.
@MainActor
final class QuickInputWindow {
    private var panel: NSPanel?
    private var resignObserver: Any?
    private var previousApp: NSRunningApplication?
    private var isDismissing = false

    /// Callback invoked when the user submits a message.
    var onSubmit: ((String) -> Void)?

    func show() {
        // Remember the frontmost app so we can restore focus on dismiss
        previousApp = NSWorkspace.shared.frontmostApplication

        if let existing = panel {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let view = QuickInputView(
            onSubmit: { [weak self] message in
                self?.onSubmit?(message)
                self?.dismiss(restorePreviousApp: false)
            },
            onDismiss: { [weak self] in
                self?.dismiss()
            }
        )

        let hostingController = NSHostingController(rootView: view)

        let panel = KeyablePanel(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 48),
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

        // Center horizontally, ~1/3 from top vertically (Spotlight-style)
        centerOnScreen(panel)

        // Animate in
        panel.alphaValue = 0
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        NSAnimationContext.runAnimationGroup { context in
            context.duration = VAnimation.durationFast
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }

        // Dismiss when the panel loses focus. Don't restore the previous
        // app — the user clicked elsewhere, so that app already has focus.
        resignObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.dismiss(restorePreviousApp: false)
            }
        }

        self.panel = panel
    }

    func dismiss(restorePreviousApp: Bool = true) {
        guard !isDismissing else { return }
        isDismissing = true

        if let resignObserver {
            NotificationCenter.default.removeObserver(resignObserver)
        }
        resignObserver = nil

        guard let panel else {
            isDismissing = false
            return
        }

        let appToRestore = restorePreviousApp ? previousApp : nil
        previousApp = nil

        NSAnimationContext.runAnimationGroup({ context in
            context.duration = VAnimation.durationFast
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            panel.close()
            self?.panel = nil
            self?.isDismissing = false
            appToRestore?.activate()
        })
    }

    var isVisible: Bool {
        panel?.isVisible ?? false
    }

    // MARK: - Private

    private func centerOnScreen(_ panel: NSPanel) {
        // Use the screen containing the mouse cursor so the panel appears
        // on the active display, even when triggered from another app.
        let mouseLocation = NSEvent.mouseLocation
        let screen = NSScreen.screens.first(where: { $0.frame.contains(mouseLocation) })
            ?? NSScreen.main
            ?? NSScreen.screens.first
        guard let screenFrame = screen?.visibleFrame else { return }

        if let fittingSize = panel.contentView?.fittingSize {
            let width = max(fittingSize.width, 500)
            let height = fittingSize.height
            let x = screenFrame.midX - width / 2
            // Position ~1/3 from top (like Spotlight)
            let y = screenFrame.midY + screenFrame.height * 0.15
            panel.setFrame(
                NSRect(x: x, y: y, width: width, height: height),
                display: true
            )
        } else {
            panel.center()
        }
    }
}
