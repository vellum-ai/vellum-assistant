import AppKit
import VellumAssistantShared
import SwiftUI

@MainActor
final class OnboardingWindow {
    private var window: NSWindow?
    private var closeObserver: NSObjectProtocol?
    let state = OnboardingState()
    let daemonClient: DaemonClientProtocol
    let authManager: AuthManager
    var onComplete: ((OnboardingState) -> Void)?

    init(daemonClient: DaemonClientProtocol, authManager: AuthManager) {
        self.daemonClient = daemonClient
        self.authManager = authManager
    }

    func show() {
        #if DEBUG
        if CommandLine.arguments.contains("--skip-permission-checks") {
            state.skipPermissionChecks = true
        }
        #endif

        let flowView = OnboardingFlowView(
            state: state,
            daemonClient: daemonClient,
            authManager: authManager,
            onComplete: { [weak self] in
                guard let self else { return }
                self.onComplete?(self.state)
            },
            onOpenSettings: { [weak self] in
                guard let self else { return }
                self.onComplete?(self.state)
                // Settings will be opened by AppDelegate after onComplete
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    NSApp.sendAction(NSSelectorFromString("showSettingsWindow:"), to: nil, from: nil)
                }
            }
        )

        let hostingController = NSHostingController(rootView: flowView)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 620),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        window.contentViewController = hostingController
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(VColor.background)
        window.isReleasedWhenClosed = false

        window.contentMinSize = NSSize(width: 420, height: 580)

        let startWidth: CGFloat = 460
        let startHeight: CGFloat = 620
        if let visibleFrame = Self.visibleScreenFrame() {
            let x = visibleFrame.midX - startWidth / 2
            let y = visibleFrame.midY - startHeight / 2
            window.setFrame(NSRect(x: x, y: y, width: startWidth, height: startHeight), display: true)
        } else {
            window.setContentSize(NSSize(width: startWidth, height: startHeight))
            window.center()
        }

        // Make the app a regular app so the window gets focus
        NSApp.setActivationPolicy(.regular)

        // Trigger onComplete when the window is closed via the title bar
        // close button so AppDelegate can clean up and transition the app.
        closeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.onComplete?(self.state)
                if let observer = self.closeObserver {
                    NotificationCenter.default.removeObserver(observer)
                }
                self.closeObserver = nil
            }
        }

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        self.window = window
    }

    func close() {
        if let observer = closeObserver {
            NotificationCenter.default.removeObserver(observer)
            closeObserver = nil
        }
        window?.close()
        window = nil
    }

    private static func visibleScreenFrame() -> NSRect? {
        if let screen = NSScreen.main {
            return screen.visibleFrame
        }
        return NSScreen.screens.first?.visibleFrame
    }
}
