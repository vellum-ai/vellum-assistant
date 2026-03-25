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
    var appId: String?
    var gatewayBaseURL: String = ""

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: NSRect(x: 0, y: 0, width: 1, height: 1))
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        context.coordinator.items = items
        context.coordinator.appName = appName
        context.coordinator.appIcon = appIcon
        context.coordinator.appId = appId
        context.coordinator.gatewayBaseURL = gatewayBaseURL
        if isPresented && !context.coordinator.isPopoverShown {
            context.coordinator.presentWhenReady(nsView: nsView) {
                self.isPresented = false
            }
        } else if !isPresented && context.coordinator.isPopoverShown {
            context.coordinator.dismissPopover()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(items: items, appName: appName, appIcon: appIcon, appId: appId, gatewayBaseURL: gatewayBaseURL)
    }

    class Coordinator: NSObject, NSPopoverDelegate {
        var items: [Any]
        var appName: String
        var appIcon: NSImage?
        var appId: String?
        var gatewayBaseURL: String
        var isPopoverShown = false
        var onDismiss: (() -> Void)?
        private var popover: NSPopover?

        init(items: [Any], appName: String, appIcon: NSImage?, appId: String?, gatewayBaseURL: String) {
            self.items = items
            self.appName = appName
            self.appIcon = appIcon
            self.appId = appId
            self.gatewayBaseURL = gatewayBaseURL
        }

        /// Waits for the NSView to be added to a window before showing the popover.
        /// When `isBundling` flips to `false` and `showSharePicker` becomes `true`
        /// in the same state update, SwiftUI swaps the spinner for the share button
        /// and creates a fresh AppSharePanel overlay. The new NSView may not yet be
        /// in a window when `updateNSView` fires, so we poll until it is.
        func presentWhenReady(nsView: NSView, attempt: Int = 0, onDismiss: @escaping () -> Void) {
            if nsView.window != nil {
                self.onDismiss = onDismiss
                showPopover(relativeTo: nsView)
                return
            }
            if attempt >= 10 {
                onDismiss()
                return
            }
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 50_000_000)
                guard !Task.isCancelled else { return }
                self?.presentWhenReady(nsView: nsView, attempt: attempt + 1, onDismiss: onDismiss)
            }
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
                appId: appId,
                gatewayBaseURL: gatewayBaseURL,
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
