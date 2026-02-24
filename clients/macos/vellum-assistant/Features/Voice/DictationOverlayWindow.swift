import AppKit
import SwiftUI
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "DictationOverlay")

@MainActor
final class DictationOverlayWindow {
    private var panel: NSPanel?
    private var currentState: DictationState = .recording

    private func panelWidth(for state: DictationState) -> CGFloat {
        switch state {
        case .transforming: return 280
        default: return 160
        }
    }

    func show(state: DictationState) {
        currentState = state
        let width = panelWidth(for: state)

        if let panel = panel {
            // Update content in-place by replacing the hosting view's root view
            if let hostingView = panel.contentView as? NSHostingView<DictationOverlayView> {
                hostingView.rootView = DictationOverlayView(state: state)
            } else {
                panel.contentView = NSHostingView(rootView: DictationOverlayView(state: state))
            }

            // Re-center if width changed
            if let screen = NSScreen.main {
                let screenFrame = screen.visibleFrame
                let x = screenFrame.midX - width / 2
                let newFrame = NSRect(x: x, y: panel.frame.origin.y, width: width, height: 40)
                panel.setFrame(newFrame, display: true, animate: false)
            }

            panel.orderFront(nil)
        } else {
            let hostingView = NSHostingView(rootView: DictationOverlayView(state: state))
            hostingView.frame = NSRect(x: 0, y: 0, width: width, height: 40)

            let newPanel = NSPanel(
                contentRect: hostingView.frame,
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            newPanel.isFloatingPanel = true
            newPanel.level = .floating
            newPanel.backgroundColor = .clear
            newPanel.isOpaque = false
            newPanel.hasShadow = false
            newPanel.contentView = hostingView
            newPanel.isMovableByWindowBackground = false

            // Position near top-center of screen
            if let screen = NSScreen.main {
                let screenFrame = screen.visibleFrame
                let x = screenFrame.midX - width / 2
                let y = screenFrame.maxY - 60
                newPanel.setFrameOrigin(NSPoint(x: x, y: y))
            }

            self.panel = newPanel
            newPanel.orderFront(nil)
        }

        log.debug("Showing dictation overlay: \(String(describing: state))")
    }

    func dismiss() {
        panel?.orderOut(nil)
        panel = nil
    }

    func showDoneAndDismiss() {
        show(state: .done)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            self?.dismiss()
        }
    }
}
