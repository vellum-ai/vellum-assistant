import AppKit
import SwiftUI

/// An NSView wrapper that presents a custom share panel (AppSharePanelView) in an
/// NSPopover anchored to itself. Replaces NSSharingServicePicker so the share panel
/// shows the app's custom icon instead of a blank document.
struct AppSharePanel: NSViewRepresentable {
    let items: [Any]
    @Binding var isPresented: Bool
    let appName: String
    let appIcon: NSImage?

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 1, height: 1))
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.items = items
        context.coordinator.appName = appName
        context.coordinator.appIcon = appIcon
        if isPresented && !context.coordinator.isPopoverShown {
            DispatchQueue.main.async {
                guard nsView.window != nil else {
                    self.isPresented = false
                    return
                }
                context.coordinator.onDismiss = {
                    self.isPresented = false
                }
                context.coordinator.showPopover(relativeTo: nsView)
            }
        } else if !isPresented && context.coordinator.isPopoverShown {
            context.coordinator.dismissPopover()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(items: items, appName: appName, appIcon: appIcon)
    }

    class Coordinator: NSObject, NSPopoverDelegate {
        var items: [Any]
        var appName: String
        var appIcon: NSImage?
        var isPopoverShown = false
        var onDismiss: (() -> Void)?
        private var popover: NSPopover?

        init(items: [Any], appName: String, appIcon: NSImage?) {
            self.items = items
            self.appName = appName
            self.appIcon = appIcon
        }

        func showPopover(relativeTo view: NSView) {
            guard let fileURL = items.compactMap({ $0 as? URL }).first(where: { $0.isFileURL }) else {
                onDismiss?()
                onDismiss = nil
                return
            }

            let panelView = AppSharePanelView(
                fileURL: fileURL,
                appName: appName,
                appIcon: appIcon,
                onDismiss: { [weak self] in
                    self?.dismissPopover()
                }
            )

            let hostingController = NSHostingController(rootView: panelView)
            hostingController.view.frame = NSRect(x: 0, y: 0, width: 240, height: 400)

            let popover = NSPopover()
            popover.contentViewController = hostingController
            popover.behavior = .transient
            popover.delegate = self
            popover.contentSize = NSSize(width: 240, height: 400)

            self.popover = popover
            isPopoverShown = true
            popover.show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
        }

        func dismissPopover() {
            popover?.performClose(nil)
            popover = nil
            isPopoverShown = false
            onDismiss?()
            onDismiss = nil
        }

        func popoverDidClose(_ notification: Notification) {
            popover = nil
            isPopoverShown = false
            onDismiss?()
            onDismiss = nil
        }
    }
}
