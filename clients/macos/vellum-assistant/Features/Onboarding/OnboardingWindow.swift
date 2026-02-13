import AppKit
import SwiftUI

@MainActor
final class OnboardingWindow {
    private var window: NSWindow?
    let state = OnboardingState()
    let daemonClient: DaemonClientProtocol
    var onComplete: ((OnboardingState) -> Void)?

    init(daemonClient: DaemonClientProtocol) {
        self.daemonClient = daemonClient
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
            onComplete: { [weak self] in
                guard let self else { return }
                self.onComplete?(self.state)
            },
            onOpenSettings: { [weak self] in
                guard let self else { return }
                self.onComplete?(self.state)
                // Settings will be opened by AppDelegate after onComplete
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                    NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
                }
            }
        )

        let hostingController = NSHostingController(rootView: flowView)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1366, height: 849),
            styleMask: [.titled, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        window.contentViewController = hostingController
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(VColor.background)
        window.isReleasedWhenClosed = false

        window.contentMinSize = NSSize(width: 800, height: 600)

        if let visibleFrame = Self.visibleScreenFrame() {
            window.setFrame(visibleFrame, display: true)
        } else {
            window.setContentSize(NSSize(width: 1366, height: 849))
            window.center()
        }

        // Make the app a regular app so the window gets focus
        NSApp.setActivationPolicy(.regular)

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        self.window = window
    }

    func close() {
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
