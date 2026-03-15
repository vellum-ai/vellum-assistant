import AppKit
import SwiftUI
import VellumAssistantShared

/// Manages an NSWindow that hosts a native SSH terminal session.
///
/// The window contains a SwiftTerm-based terminal view connected to the platform's
/// PTY terminal API. Session lifecycle (connect, disconnect, cleanup) is handled
/// automatically when the window opens and closes.
@MainActor
final class SSHTerminalWindow {

    private var window: NSWindow?
    private var sessionManager: TerminalSessionManager?

    /// Opens a new terminal window for the given managed assistant.
    ///
    /// - Parameter assistant: The managed assistant to connect to.
    func open(assistant: LockfileAssistant) {
        // If a window is already open, bring it to front.
        if let existing = window, existing.isVisible {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let apiClient = TerminalAPIClient(assistantId: assistant.assistantId)
        let manager = TerminalSessionManager(apiClient: apiClient)
        self.sessionManager = manager

        let contentView = SSHTerminalContentView(sessionManager: manager)
        let hostingController = NSHostingController(rootView: contentView)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1024, height: 768),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )

        window.contentViewController = hostingController
        window.title = "Terminal — \(assistant.assistantId)"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 600, height: 400)
        window.setContentSize(NSSize(width: 1024, height: 768))
        window.center()

        // Clean up on close.
        NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.sessionManager?.close()
                self?.sessionManager = nil
                self?.window = nil
            }
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activateAsDockAppIfNeeded()
        self.window = window

        // Auto-connect the terminal session.
        manager.connect()
    }

    func close() {
        sessionManager?.close()
        sessionManager = nil
        window?.close()
        window = nil
    }
}

// MARK: - Content View

/// SwiftUI root view for the terminal window, composing the terminal view
/// with a status toolbar.
private struct SSHTerminalContentView: View {
    @ObservedObject var sessionManager: TerminalSessionManager

    var body: some View {
        VStack(spacing: 0) {
            terminalToolbar
            SSHTerminalView(sessionManager: sessionManager)
                .padding(8)
                .background(VColor.surfaceBase)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(VColor.surfaceBase)
    }

    private var terminalToolbar: some View {
        HStack(spacing: VSpacing.sm) {
            statusIndicator
            Text(statusText)
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)

            Spacer()

            if case .error = sessionManager.status {
                VButton(label: "Reconnect", style: .outlined) {
                    sessionManager.reconnect()
                }
            }

            if case .connected = sessionManager.status {
                VButton(label: "Disconnect", style: .outlined) {
                    sessionManager.close()
                }
            }

            if case .closed = sessionManager.status {
                VButton(label: "Connect", style: .primary) {
                    sessionManager.connect()
                }
            }
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
        .background(VColor.surfaceBase)
    }

    @ViewBuilder
    private var statusIndicator: some View {
        Circle()
            .fill(statusColor)
            .frame(width: 8, height: 8)
    }

    private var statusColor: Color {
        switch sessionManager.status {
        case .idle, .closed:
            return VColor.contentTertiary
        case .connecting, .reconnecting:
            return VColor.systemNegativeHover
        case .connected:
            return VColor.systemPositiveStrong
        case .error:
            return VColor.systemNegativeStrong
        }
    }

    private var statusText: String {
        switch sessionManager.status {
        case .idle:
            return "Idle"
        case .connecting:
            return "Connecting..."
        case .connected:
            return "Connected"
        case .reconnecting:
            return "Reconnecting..."
        case .error(let message):
            return "Error: \(message)"
        case .closed:
            return "Disconnected"
        }
    }
}
