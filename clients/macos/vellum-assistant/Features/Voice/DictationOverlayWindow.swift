import AppKit
import SwiftUI
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "DictationOverlay")

@MainActor
final class DictationOverlayWindow {
    private var panel: NSPanel?
    private var state: DictationState = .recording

    func show(state: DictationState) {
        self.state = state

        if panel == nil {
            let hostingView = NSHostingView(rootView: DictationOverlayView(state: state))
            hostingView.frame = NSRect(x: 0, y: 0, width: 160, height: 40)

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
                let x = screenFrame.midX - 80
                let y = screenFrame.maxY - 60
                panel.setFrameOrigin(NSPoint(x: x, y: y))
            }

            self.panel = panel
        } else {
            let hostingView = NSHostingView(rootView: DictationOverlayView(state: state))
            panel?.contentView = hostingView
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
