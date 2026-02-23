import AppKit
import Combine
import SwiftUI

@MainActor
final class SessionOverlayWindow {
    private var panel: NSPanel?
    private let session: ComputerUseSession
    private var layoutCancellable: AnyCancellable?

    init(session: ComputerUseSession) {
        self.session = session
    }

    func show() {
        let overlayView = SessionOverlayView(session: session)
        let hostingController = NSHostingController(rootView: overlayView)

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 340, height: 160),
            styleMask: [.titled, .nonactivatingPanel, .utilityWindow, .hudWindow],
            backing: .buffered,
            defer: false
        )

        panel.contentViewController = hostingController
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.alphaValue = 0.9
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]

        // Size window to fit SwiftUI content and resize on every state change
        sizeAndPosition(panel)
        layoutCancellable = session.objectWillChange
            .sink { [weak self, weak panel] _ in
                guard let self, let panel else { return }
                DispatchQueue.main.async {
                    self.sizeAndPosition(panel)
                }
            }

        panel.orderFront(nil)
        self.panel = panel
    }

    func bringToFront() {
        panel?.orderFrontRegardless()
    }

    func close() {
        layoutCancellable?.cancel()
        layoutCancellable = nil
        panel?.close()
        panel = nil
    }

    private func sizeAndPosition(_ panel: NSPanel) {
        if let fittingSize = panel.contentView?.fittingSize {
            panel.setContentSize(fittingSize)
        }
        // Pin to bottom-right of screen
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let panelFrame = panel.frame
            let x = screenFrame.maxX - panelFrame.width - 20
            let y = screenFrame.minY + 20
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }
    }
}
