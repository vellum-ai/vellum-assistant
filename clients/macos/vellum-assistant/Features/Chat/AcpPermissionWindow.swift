import AppKit
import SwiftUI
import VellumAssistantShared

/// Manages a floating NSWindow for ACP agent permission prompts.
/// Auto-centers, activates app, idempotent show/close.
@MainActor
final class AcpPermissionWindow {
    private var window: NSWindow?
    private var currentRequestId: String?
    private var responseSent: Bool = false
    private var windowDelegate: AcpPermissionWindowCloseDelegate?

    /// Show the permission approval prompt for an ACP tool call.
    /// If a window is already showing for a different request, it is closed first
    /// (one prompt at a time) and the first reject option is sent for the superseded request.
    /// If the same requestId is delivered again (daemon retry/rebroadcast),
    /// the existing prompt is kept as-is.
    func show(message: AcpPermissionRequestMessage) {
        // Same request ID redelivered — keep current prompt.
        if message.requestId == currentRequestId, window != nil {
            return
        }

        // Close any existing prompt before showing a new one.
        close(defaultOptionId: findRejectOptionId(message.options))

        let rawInputString: String? = {
            guard let rawInput = message.rawInput?.value else { return nil }
            if let str = rawInput as? String { return str }
            if let data = try? JSONSerialization.data(withJSONObject: rawInput, options: [.prettyPrinted, .sortedKeys]),
               let str = String(data: data, encoding: .utf8) {
                return str
            }
            return String(describing: rawInput)
        }()

        let rejectOptionId = findRejectOptionId(message.options)
        let requestId = message.requestId

        let view = AcpPermissionView(
            toolTitle: message.toolTitle,
            toolKind: message.toolKind,
            rawInput: rawInputString,
            options: message.options
        ) { [weak self] optionId in
            guard let self else { return }
            self.responseSent = true
            Task {
                _ = await InteractionClient().sendAcpPermissionResponse(
                    requestId: requestId,
                    optionId: optionId
                )
            }
            self.close()
        }

        let hostingController = NSHostingController(rootView: view)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 240),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )

        window.contentViewController = hostingController
        window.title = "Agent Permission Request"
        window.level = .floating
        window.isReleasedWhenClosed = false
        window.center()

        // Delegate catches X-button close and sends reject if no response was sent.
        let delegate = AcpPermissionWindowCloseDelegate { [weak self] in
            self?.handleWindowClosed(rejectOptionId: rejectOptionId)
        }
        window.delegate = delegate
        self.windowDelegate = delegate

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        self.window = window
        self.currentRequestId = message.requestId
        self.responseSent = false
    }

    var isVisible: Bool {
        window?.isVisible ?? false
    }

    func close(defaultOptionId: String? = nil) {
        rejectIfNeeded(optionId: defaultOptionId)
        window?.close()
        window = nil
        windowDelegate = nil
    }

    // MARK: - Private

    private func findRejectOptionId(_ options: [AcpPermissionRequestMessage.Option]) -> String? {
        options.first(where: { $0.kind.hasPrefix("reject") })?.optionId
    }

    /// Sends a reject for the current request if no explicit response has been sent yet.
    private func rejectIfNeeded(optionId: String? = nil) {
        guard let requestId = currentRequestId, !responseSent else { return }
        guard let rejectId = optionId else { return }
        responseSent = true
        Task {
            _ = await InteractionClient().sendAcpPermissionResponse(
                requestId: requestId,
                optionId: rejectId
            )
        }
    }

    /// Called by the window delegate when the user clicks the X button.
    private func handleWindowClosed(rejectOptionId: String?) {
        rejectIfNeeded(optionId: rejectOptionId)
        window = nil
        windowDelegate = nil
    }
}

// MARK: - AcpPermissionWindowCloseDelegate

/// Lightweight NSWindowDelegate that forwards windowWillClose to a closure.
private final class AcpPermissionWindowCloseDelegate: NSObject, NSWindowDelegate {
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
