import AppKit
import SwiftTerm
import SwiftUI

/// NSViewRepresentable wrapper around SwiftTerm's `TerminalView` for use in SwiftUI.
///
/// Handles bridging between SwiftTerm's delegate callbacks (keyboard input, resize)
/// and the `TerminalSessionManager` that communicates with the platform terminal API.
struct SSHTerminalView: NSViewRepresentable {

    var sessionManager: TerminalSessionManager

    func makeNSView(context: Context) -> TerminalView {
        let terminalView = TerminalView(frame: .zero)
        terminalView.terminalDelegate = context.coordinator
        terminalView.configureNativeColors()

        // Hide the internal NSScroller to remove the visible track gutter.
        // Scrolling still works via trackpad and mouse wheel.
        Self.hideScroller(in: terminalView)

        // Register the coordinator so the session manager can write output to the terminal.
        context.coordinator.terminalView = terminalView
        sessionManager.onData = { [weak coordinator = context.coordinator] base64Data in
            guard let coordinator else { return }
            coordinator.writeBase64Data(base64Data)
        }

        return terminalView
    }

    func updateNSView(_ nsView: TerminalView, context: Context) {
        // Re-apply scroller hiding in case SwiftTerm recreates or shows it.
        Self.hideScroller(in: nsView)
    }

    /// Hides any NSScroller subviews inside the terminal view.
    private static func hideScroller(in view: TerminalView) {
        for subview in view.subviews where subview is NSScroller {
            subview.isHidden = true
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(sessionManager: sessionManager)
    }

    // MARK: - Coordinator

    final class Coordinator: NSObject, TerminalViewDelegate {
        weak var terminalView: TerminalView?
        private let sessionManager: TerminalSessionManager

        init(sessionManager: TerminalSessionManager) {
            self.sessionManager = sessionManager
        }

        /// Writes base64-encoded PTY output to the terminal view.
        func writeBase64Data(_ base64: String) {
            guard let decoded = Data(base64Encoded: base64) else {
                // Fall back to writing the raw string if base64 decoding fails.
                terminalView?.feed(text: base64)
                return
            }
            let bytes = Array(decoded)
            terminalView?.feed(byteArray: bytes[bytes.startIndex...])
        }

        // MARK: - TerminalViewDelegate

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            let str = String(bytes: data, encoding: .utf8) ?? ""
            guard !str.isEmpty else { return }
            Task { @MainActor in
                self.sessionManager.sendInput(str)
            }
        }

        func scrolled(source: TerminalView, position: Double) {
            // No action needed for scroll events.
        }

        func setTerminalTitle(source: TerminalView, title: String) {
            // Title changes are ignored — the window title is managed separately.
        }

        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {
            Task { @MainActor in
                self.sessionManager.sendResize(cols: newCols, rows: newRows)
            }
        }

        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {
            // Not used for remote terminal sessions.
        }

        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            guard let url = URL(string: link) else { return }
            NSWorkspace.shared.open(url)
        }

        func bell(source: TerminalView) {
            NSSound.beep()
        }

        func clipboardCopy(source: TerminalView, content: Data) {
            guard let str = String(data: content, encoding: .utf8) else { return }
            let pasteboard = NSPasteboard.general
            pasteboard.clearContents()
            pasteboard.setString(str, forType: .string)
        }

        func iTermContent(source: TerminalView, content: ArraySlice<UInt8>) {
            // Not used for remote terminal sessions.
        }

        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {
            // No action needed — terminal view redraws automatically.
        }
    }
}
