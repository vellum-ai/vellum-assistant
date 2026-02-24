import AppKit
import SwiftUI
import VellumAssistantShared

/// Manages a floating NSWindow for pairing approval prompts.
/// Follows the TasksWindow pattern — auto-centers, activates app, idempotent show/close.
@MainActor
final class PairingApprovalWindow {
    private var window: NSWindow?
    private let daemonClient: DaemonClient

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
    }

    /// Show the pairing approval prompt for a specific device.
    /// If a window is already showing, it is closed first (one prompt at a time).
    func show(pairingRequestId: String, deviceName: String) {
        // Close any existing prompt before showing a new one
        close()

        let view = PairingApprovalView(deviceName: deviceName) { [weak self] decision in
            guard let self else { return }
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

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        self.window = window
    }

    var isVisible: Bool {
        window?.isVisible ?? false
    }

    func close() {
        window?.close()
        window = nil
    }
}
