#if DEBUG && os(macOS)
import AppKit
import SwiftUI

@MainActor
public final class ComponentGalleryWindow {
    private var window: NSWindow?

    public init() {}

    public func show() {
        if let existing = window {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let hostingController = NSHostingController(rootView: ComponentGalleryView())

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 700),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        window.contentViewController = hostingController
        window.title = "Component Gallery"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(VColor.surfaceBase)
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 800, height: 500)

        window.setContentSize(NSSize(width: 1100, height: 700))
        window.center()

        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        self.window = window
    }

    public func close() {
        window?.close()
        window = nil
    }
}
#endif
