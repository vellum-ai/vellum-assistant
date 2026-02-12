import AppKit
import Combine
import SwiftUI

/// Shared state for routing voice input into an active conversation panel.
@MainActor
final class ConversationInputState: ObservableObject {
    @Published var inputText: String = ""
    @Published var isRecording: Bool = false

    nonisolated init() {
        // Properties are initialized with defaults above
    }
}

@MainActor
final class TextResponseWindow {
    private var panel: NSPanel?
    private let session: TextSession
    let inputState: ConversationInputState
    private var stateCancellable: AnyCancellable?
    private var resizeObserver: Any?
    private var closeObserver: Any?
    private var hasBeenPositioned = false

    /// Called when the user closes the panel (X button or programmatic close).
    var onClose: (() -> Void)?

    init(session: TextSession, inputState: ConversationInputState = ConversationInputState()) {
        self.session = session
        self.inputState = inputState
    }

    func show() {
        let savedWidth = UserDefaults.standard.double(forKey: "textResponsePanelWidth")
        let initialWidth = savedWidth > 0 ? savedWidth : 500.0

        let view = TextResponseView(session: session, inputState: inputState) { [weak self] in
            self?.panel?.close()
        }
        let hostingController = NSHostingController(rootView: view)

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: initialWidth, height: 200),
            styleMask: [.titled, .nonactivatingPanel, .utilityWindow, .hudWindow, .resizable],
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
        panel.collectionBehavior = [.canJoinAllSpaces]
        panel.minSize = NSSize(width: 300, height: 200)
        panel.maxSize = NSSize(width: 600, height: 10000)

        // Initial size and position
        sizeAndPosition(panel)
        hasBeenPositioned = true

        // Resize on state change — only adjust height, keep user's position
        stateCancellable = session.$state
            .sink { [weak self, weak panel] _ in
                guard let self, let panel else { return }
                self.resizeHeight(panel)
            }

        // Persist width on resize
        resizeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResizeNotification, object: panel, queue: .main
        ) { notification in
            guard let window = notification.object as? NSPanel else { return }
            UserDefaults.standard.set(Double(window.frame.width), forKey: "textResponsePanelWidth")
        }

        // Fire onClose when the panel is closed by the user
        closeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: panel, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.onClose?()
            }
        }

        panel.orderFront(nil)
        self.panel = panel
    }

    /// Called when partial transcription arrives during Fn-hold in an active conversation.
    func updatePartialTranscription(_ text: String) {
        inputState.inputText = text
    }

    /// Called when recording state changes.
    func updateRecordingState(_ isRecording: Bool) {
        inputState.isRecording = isRecording
    }

    func close() {
        stateCancellable?.cancel()
        stateCancellable = nil
        if let resizeObserver { NotificationCenter.default.removeObserver(resizeObserver) }
        resizeObserver = nil
        if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
        closeObserver = nil
        panel?.close()
        panel = nil
    }

    /// Full size-and-position: used only on initial show.
    /// Pins the panel to the top-right corner of the screen.
    private func sizeAndPosition(_ panel: NSPanel) {
        if let fittingSize = panel.contentView?.fittingSize {
            let width = panel.frame.width // keep the initial/saved width
            let maxHeight: CGFloat
            if let screen = NSScreen.main {
                maxHeight = screen.visibleFrame.height - 40
            } else {
                maxHeight = 800
            }
            let height = min(fittingSize.height, maxHeight)
            panel.setContentSize(NSSize(width: width, height: height))
        }
        // Pin to top-right of screen
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let panelFrame = panel.frame
            let x = screenFrame.maxX - panelFrame.width - 20
            let y = screenFrame.maxY - panelFrame.height - 20
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }
    }

    /// Resize height only — keep the top edge pinned and grow downward.
    private func resizeHeight(_ panel: NSPanel) {
        guard let fittingSize = panel.contentView?.fittingSize else { return }
        let maxHeight: CGFloat
        if let screen = NSScreen.main {
            maxHeight = screen.visibleFrame.height - 40
        } else {
            maxHeight = 800
        }
        let currentFrame = panel.frame
        // Never auto-shrink — only grow taller during a conversation.
        // The user can still manually drag-resize shorter if they want.
        let newHeight = max(currentFrame.height, min(fittingSize.height, maxHeight))
        // Grow downward: keep top edge fixed
        let topY = currentFrame.maxY
        panel.setFrame(
            NSRect(x: currentFrame.minX, y: topY - newHeight, width: currentFrame.width, height: newHeight),
            display: true,
            animate: false
        )
    }
}
