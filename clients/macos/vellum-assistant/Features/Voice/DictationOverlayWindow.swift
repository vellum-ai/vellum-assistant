import AppKit
import SwiftUI
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "DictationOverlay")

@MainActor
final class DictationOverlayWindow {
    private var panel: NSPanel?
    private var state: DictationState = .recording

    private func panelWidth(for state: DictationState) -> CGFloat {
        switch state {
        case .transforming: return 280
        default: return 160
        }
    }

    func show(state: DictationState) {
        self.state = state
        let width = panelWidth(for: state)

        if panel == nil {
            let hostingView = NSHostingView(rootView: DictationOverlayView(state: state))
            hostingView.frame = NSRect(x: 0, y: 0, width: width, height: 40)

            let panel = NSPanel(
                contentRect: hostingView.frame,
                styleMask: [.nonactivatingPanel, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            panel.isFloatingPanel = true
            panel.level = .floating
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = false
            panel.contentView = hostingView
            panel.isMovableByWindowBackground = false

            // Position near top-center of screen
            if let screen = NSScreen.main {
                let screenFrame = screen.visibleFrame
                let x = screenFrame.midX - width / 2
                let y = screenFrame.maxY - 60
                panel.setFrameOrigin(NSPoint(x: x, y: y))
            }

            self.panel = panel
        } else {
            let hostingView = NSHostingView(rootView: DictationOverlayView(state: state))
            hostingView.frame = NSRect(x: 0, y: 0, width: width, height: 40)
            panel?.contentView = hostingView

            // Re-center when width changes (e.g. switching to/from transforming state)
            if let screen = NSScreen.main, let panel = panel {
                let screenFrame = screen.visibleFrame
                let x = screenFrame.midX - width / 2
                panel.setFrameOrigin(NSPoint(x: x, y: panel.frame.origin.y))
                panel.setContentSize(NSSize(width: width, height: 40))
            }
        }

        panel?.orderFront(nil)
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
