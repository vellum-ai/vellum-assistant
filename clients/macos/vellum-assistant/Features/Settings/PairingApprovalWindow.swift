import AppKit
import SwiftUI
import VellumAssistantShared

/// Manages a floating NSWindow for pairing approval prompts.
/// Follows the TasksWindow pattern — auto-centers, activates app, idempotent show/close.
@MainActor
final class PairingApprovalWindow {
    private var window: NSWindow?
    private let daemonClient: DaemonClient
    private var currentPairingRequestId: String?
    private var responseSent: Bool = false
    private var windowDelegate: WindowCloseDelegate?

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
    }

    /// Show the pairing approval prompt for a specific device.
    /// If a window is already showing, it is closed first (one prompt at a time).
    /// Closing the previous window sends a deny for the superseded request.
    func show(pairingRequestId: String, deviceName: String) {
        // Close any existing prompt before showing a new one.
        // This will send a deny for the previous request if unanswered.
        close()

        let view = PairingApprovalView(deviceName: deviceName) { [weak self] decision in
            guard let self else { return }
            self.responseSent = true
            try? self.daemonClient.sendPairingApprovalResponse(
                pairingRequestId: pairingRequestId,
                decision: decision
            )
            self.close()
        }

        let hostingController = NSHostingController(rootView: view)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 200),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )

        window.contentViewController = hostingController
        window.title = "Pairing Request"
        window.level = .floating
        window.isReleasedWhenClosed = false
        window.center()

        // Delegate catches X-button close and sends deny if no response was sent.
        let delegate = WindowCloseDelegate { [weak self] in
            self?.handleWindowClosed()
        }
        window.delegate = delegate
        self.windowDelegate = delegate

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        self.window = window
        self.currentPairingRequestId = pairingRequestId
        self.responseSent = false
    }

    var isVisible: Bool {
        window?.isVisible ?? false
    }

    func close() {
        denyIfNeeded()
        window?.close()
        window = nil
        windowDelegate = nil
    }

    // MARK: - Private

    /// Sends a deny for the current request if no explicit response has been sent yet.
    private func denyIfNeeded() {
        guard let requestId = currentPairingRequestId, !responseSent else { return }
        responseSent = true
        try? daemonClient.sendPairingApprovalResponse(
            pairingRequestId: requestId,
            decision: "deny"
        )
    }

    /// Called by the window delegate when the user clicks the X button.
    private func handleWindowClosed() {
        denyIfNeeded()
        window = nil
        windowDelegate = nil
    }
}

// MARK: - WindowCloseDelegate

/// Lightweight NSWindowDelegate that forwards windowWillClose to a closure.
private final class WindowCloseDelegate: NSObject, NSWindowDelegate {
    private let onClose: @MainActor () -> Void

    init(onClose: @escaping @MainActor () -> Void) {
        self.onClose = onClose
    }

    func windowWillClose(_ notification: Notification) {
        MainActor.assumeIsolated {
            onClose()
        }
    }
}
