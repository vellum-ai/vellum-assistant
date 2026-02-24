import AppKit
import SwiftUI
import VellumAssistantShared

/// Borderless NSPanel subclass that can become key window.
/// Without this override, borderless windows refuse key status
/// and SwiftUI TextEditor won't accept keyboard input.
private class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

/// A borderless, floating NSPanel that hosts the Quick Chat text editor.
/// Appears centered on the active screen with a vibrancy/blur background.
/// Dismisses itself when it resigns key window status.
@MainActor
final class QuickChatPanel {
    private var panel: NSPanel?
    private var toastPanel: NSPanel?
    private var resignObserver: Any?
    private var previousApp: NSRunningApplication?

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

        let view = QuickChatView(
            onSubmit: { [weak self] message in
                self?.onSubmit?(message)
                // Capture position before dismissing so the toast appears in the same spot
                let panelFrame = self?.panel?.frame
                self?.dismiss()
                if let frame = panelFrame {
                    self?.showSentToast(near: frame)
                }
            },
            onDismiss: { [weak self] in
                self?.dismiss()
            }
        )

        let hostingController = NSHostingController(rootView: view)

        let panel = KeyablePanel(
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

        // Animate in: start transparent and slightly scaled down, then animate to full
        panel.alphaValue = 0
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        NSAnimationContext.runAnimationGroup { context in
            context.duration = VAnimation.durationFast
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = 1
        }

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

        guard let panel else { return }

        // Restore focus to the app that was active before Quick Chat appeared
        let appToRestore = previousApp
        previousApp = nil

        // Animate out: fade to transparent, then close
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = VAnimation.durationFast
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            panel.close()
            self?.panel = nil
            appToRestore?.activate()
        })
    }

    var isVisible: Bool {
        panel?.isVisible ?? false
    }

    // MARK: - Private

    /// Shows a brief "Message sent" toast near the given frame, then auto-dismisses.
    private func showSentToast(near frame: NSRect) {
        // Close any existing toast immediately to prevent timer races
        if let existing = toastPanel {
            existing.close()
            toastPanel = nil
        }

        let toastView = HStack(spacing: VSpacing.sm) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundColor(VColor.success)
            Text("Message sent")
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(
            VisualEffectBlur(material: .hudWindow, blendingMode: .behindWindow)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))

        let hosting = NSHostingController(rootView: toastView)

        let toast = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 180, height: 40),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        toast.contentViewController = hosting
        toast.level = .floating
        toast.titleVisibility = .hidden
        toast.titlebarAppearsTransparent = true
        toast.isReleasedWhenClosed = false
        toast.backgroundColor = .clear
        toast.isOpaque = false
        toast.hasShadow = true
        toast.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        // Position just below where the Quick Chat panel was
        if let fittingSize = toast.contentView?.fittingSize {
            let x = frame.midX - fittingSize.width / 2
            let y = frame.origin.y - fittingSize.height - 8
            toast.setFrame(
                NSRect(x: x, y: y, width: fittingSize.width, height: fittingSize.height),
                display: true
            )
        }

        toast.alphaValue = 0
        toast.orderFrontRegardless()

        NSAnimationContext.runAnimationGroup { context in
            context.duration = VAnimation.durationFast
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            toast.animator().alphaValue = 1
        }

        self.toastPanel = toast

        // Auto-dismiss after 1.5 seconds. Capture `toast` directly so it's
        // always closed even if `self` (QuickChatPanel) is deallocated first.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = VAnimation.durationFast
                context.timingFunction = CAMediaTimingFunction(name: .easeIn)
                toast.animator().alphaValue = 0
            }, completionHandler: {
                toast.close()
                if self?.toastPanel === toast {
                    self?.toastPanel = nil
                }
            })
        }
    }

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
