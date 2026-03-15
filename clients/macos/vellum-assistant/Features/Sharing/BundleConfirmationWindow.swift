import VellumAssistantShared
import AppKit
import SwiftUI

@MainActor
final class BundleConfirmationWindow {
    private var window: NSWindow?
    private var viewModel: BundleConfirmationViewModel?

    func show(viewModel: BundleConfirmationViewModel) {
        // Close any existing window
        close()

        self.viewModel = viewModel

        let confirmationView = BundleConfirmationView(viewModel: viewModel)
        let hostingController = NSHostingController(rootView: confirmationView)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 400),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        window.contentViewController = hostingController
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(VColor.surfaceOverlay)
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.center()

        NSApp.activateAsDockAppIfNeeded()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        self.window = window
    }

    func close() {
        window?.close()
        window = nil
        viewModel = nil
    }
}
