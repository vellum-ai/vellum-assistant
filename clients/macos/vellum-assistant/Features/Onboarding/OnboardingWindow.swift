import AppKit
import VellumAssistantShared
import SwiftUI

@MainActor
final class OnboardingWindow {
    private var window: NSWindow?
    private var closeObserver: NSObjectProtocol?
    let state = OnboardingState()
    let connectionManager: GatewayConnectionManager
    let authManager: AuthManager
    var onComplete: ((OnboardingState) -> Void)?
    /// Called when the user closes the window before completing onboarding.
    var onDismiss: (() -> Void)?

    init(connectionManager: GatewayConnectionManager, authManager: AuthManager) {
        self.connectionManager = connectionManager
        self.authManager = authManager
    }

    func show() {
        let flowView = OnboardingFlowView(
            state: state,
            connectionManager: connectionManager,
            authManager: authManager,
            managedBootstrapEnabled: true,
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
            contentRect: NSRect(x: 0, y: 0, width: 520, height: 740),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        window.contentViewController = hostingController
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(VColor.surfaceOverlay)
        window.isReleasedWhenClosed = false
        window.contentView?.wantsLayer = true
        window.contentView?.layer?.cornerRadius = 24
        window.contentView?.layer?.masksToBounds = true

        window.contentMinSize = NSSize(width: 440, height: 630)

        let startWidth: CGFloat = 440
        let startHeight: CGFloat = 630
        if let visibleFrame = Self.visibleScreenFrame() {
            let x = visibleFrame.midX - startWidth / 2
            let y = visibleFrame.midY - startHeight / 2
            window.setFrame(NSRect(x: x, y: y, width: startWidth, height: startHeight), display: true)
        } else {
            window.setContentSize(NSSize(width: startWidth, height: startHeight))
            window.center()
        }

        // Make the app a regular app so the window gets focus
        NSApp.activateAsDockAppIfNeeded()

        // When the user closes the window via the title bar close button,
        // only proceed if onboarding actually completed. Closing before
        // completion should not trigger daemon hatching.
        // NOTE: We intentionally check only hatchCompleted here, not
        // authManager.isAuthenticated. A restored auth session does NOT
        // mean the user finished the onboarding flow — treating it as
        // "completed" would cause proceedToApp to hatch a local assistant
        // even though the user never configured one.
        closeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor [weak self] in
                guard let self else { return }
                if self.state.hatchCompleted {
                    self.onComplete?(self.state)
                } else {
                    self.onDismiss?()
                }
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

    func bringToFront() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
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
