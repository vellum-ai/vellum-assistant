import AppKit
import SwiftUI
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "SurfaceManager")

/// Observable view model that holds the current surface state.
/// Kept alive across updates so that child SwiftUI views preserve their @State (e.g. form inputs).
@MainActor
@Observable
final class SurfaceViewModel {
    var surface: Surface
    @ObservationIgnored let onAction: (String, [String: Any]?) -> Void
    @ObservationIgnored let onDismiss: () -> Void
    @ObservationIgnored let appId: String?
    @ObservationIgnored let onDataRequest: ((String, String, String?, [String: Any]?) -> Void)?
    @ObservationIgnored let onCoordinatorReady: ((DynamicPageSurfaceView.Coordinator) -> Void)?
    @ObservationIgnored let onLinkOpen: ((String, [String: Any]?) -> Void)?
    @ObservationIgnored let sandboxMode: Bool

    init(
        surface: Surface,
        onAction: @escaping (String, [String: Any]?) -> Void,
        onDismiss: @escaping () -> Void,
        appId: String? = nil,
        onDataRequest: ((String, String, String?, [String: Any]?) -> Void)? = nil,
        onCoordinatorReady: ((DynamicPageSurfaceView.Coordinator) -> Void)? = nil,
        onLinkOpen: ((String, [String: Any]?) -> Void)? = nil,
        sandboxMode: Bool = false
    ) {
        self.surface = surface
        self.onAction = onAction
        self.onDismiss = onDismiss
        self.appId = appId
        self.onDataRequest = onDataRequest
        self.onCoordinatorReady = onCoordinatorReady
        self.onLinkOpen = onLinkOpen
        self.sandboxMode = sandboxMode
    }
}

/// Manages the lifecycle of surface windows (NSPanel) shown in response to daemon messages.
///
/// Each surface is displayed in a floating, non-activating panel positioned at the bottom-right
/// of the screen, using a floating, non-activating NSPanel.
@MainActor
@Observable
final class SurfaceManager {

    // MARK: - Reactive State

    var activeSurfaces: [String: Surface] = [:]

    // MARK: - Non-reactive Bookkeeping

    @ObservationIgnored private var panels: [String: NSPanel] = [:]
    @ObservationIgnored private var viewModels: [String: SurfaceViewModel] = [:]

    /// Tracks appId per surface for persistent app RPC routing.
    @ObservationIgnored var surfaceAppIds: [String: String] = [:]

    /// Tracks Coordinator per surface for routing data responses back to WebView.
    @ObservationIgnored var surfaceCoordinators: [String: DynamicPageSurfaceView.Coordinator] = [:]

    /// Ordered list of surface IDs for deterministic stacking positions.
    @ObservationIgnored private var surfaceOrder: [String] = []

    /// Surfaces that have already sent an action to the daemon.
    /// Prevents duplicate actions (e.g. submit followed by dismiss) from racing.
    @ObservationIgnored private var respondedSurfaces: Set<String> = []

    /// Surfaces routed to the workspace instead of floating NSPanels.
    /// Tracked so that update/dismiss messages can be forwarded via notifications.
    @ObservationIgnored private var workspaceRoutedSurfaces: Set<String> = []

    @ObservationIgnored private var closeObservers: [String: Any] = [:]

    @ObservationIgnored private let panelWidth: CGFloat = 380
    @ObservationIgnored private let panelMargin: CGFloat = 20
    @ObservationIgnored private let panelSpacing: CGFloat = 10

    // MARK: - Action Callback

    /// Called when a user interacts with a surface action button.
    /// Parameters: conversationId (optional), surfaceId, actionId, optional data dictionary.
    @ObservationIgnored var onAction: ((String?, String, String, [String: Any]?) -> Void)?

    /// Called when a persistent app's JS makes a data request via the RPC bridge.
    /// Parameters: surfaceId, callId, method, appId, recordId, data.
    @ObservationIgnored var onDataRequest: ((String, String, String, String, String?, [String: Any]?) -> Void)?

    /// When set, dynamic pages with `display != "inline"` route to the full-window
    /// workspace instead of opening as floating NSPanels.
    @ObservationIgnored var onDynamicPageShow: ((UiSurfaceShowMessage) -> Void)?

    /// Called when a dynamic page requests opening an external link.
    /// Parameters: url string, optional metadata dictionary.
    @ObservationIgnored var onLinkOpen: ((String, [String: Any]?) -> Void)?

    // MARK: - Show

    func showSurface(_ message: UiSurfaceShowMessage) {
        guard let surface = Surface.from(message) else {
            log.error("Failed to parse surface from message: surfaceId=\(message.surfaceId), type=\(message.surfaceType)")
            return
        }

        // Dismiss any existing surface with the same ID first.
        if panels[surface.id] != nil || workspaceRoutedSurfaces.contains(surface.id) {
            dismissSurfaceById(surface.id)
        }

        activeSurfaces[surface.id] = surface
        surfaceOrder.append(surface.id)

        // Extract and track appId for persistent app RPC routing.
        let dict = message.data.value as? [String: Any?] ?? [:]
        if let appId = dict["appId"] as? String {
            surfaceAppIds[surface.id] = appId
            log.info("Extracted appId=\(appId, privacy: .public) for surface=\(surface.id, privacy: .public)")
        } else if message.surfaceType == "dynamic_page" {
            let keys = dict.keys.joined(separator: ", ")
            log.warning("dynamic_page surface has no appId — data bridge will not be injected. Keys in data: [\(keys)]")
        }
        // Route dynamic pages to workspace if callback is set.
        // Registration above ensures update/dismiss messages still work.
        if case .dynamicPage = surface.data,
           message.display != "inline",
           let onDynamicPageShow {
            workspaceRoutedSurfaces.insert(surface.id)
            onDynamicPageShow(message)
            log.info("Routed surface to workspace: id=\(surface.id, privacy: .public)")
            return
        }

        let appId = surfaceAppIds[surface.id]
        let isSandboxed = message.conversationId == "shared-app"

        let viewModel = SurfaceViewModel(
            surface: surface,
            onAction: { [weak self] actionId, data in
                guard let self, !self.respondedSurfaces.contains(surface.id) else { return }
                self.respondedSurfaces.insert(surface.id)
                self.onAction?(surface.conversationId, surface.id, actionId, data)
            },
            onDismiss: { [weak self] in
                guard let self, !self.respondedSurfaces.contains(surface.id) else {
                    self?.dismissSurfaceById(surface.id)
                    return
                }
                self.respondedSurfaces.insert(surface.id)
                self.onAction?(surface.conversationId, surface.id, "dismiss", nil)
                self.dismissSurfaceById(surface.id)
            },
            appId: appId,
            onDataRequest: appId != nil ? { [weak self] callId, method, recordId, data in
                guard let appId = self?.surfaceAppIds[surface.id] else { return }
                self?.onDataRequest?(surface.id, callId, method, appId, recordId, data)
            } : nil,
            onCoordinatorReady: appId != nil ? { [weak self] coordinator in
                self?.surfaceCoordinators[surface.id] = coordinator
            } : nil,
            onLinkOpen: { [weak self] url, metadata in
                self?.onLinkOpen?(url, metadata)
            },
            sandboxMode: isSandboxed
        )
        viewModels[surface.id] = viewModel

        let view = SurfaceContainerView(viewModel: viewModel)

        let isDP = if case .dynamicPage = surface.data { true } else { false }
        let hostingController = isDP
            ? NSHostingController(rootView: AnyView(view))
            : NSHostingController(rootView: AnyView(view.ignoresSafeArea(.all, edges: .top)))

        let surfacePanelWidth: CGFloat
        let surfacePanelHeight: CGFloat
        if case .dynamicPage(let dpData) = surface.data {
            let screen = NSScreen.main?.visibleFrame ?? NSScreen.screens.first?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            let defaultW = Int(screen.width * 0.45)
            let defaultH = Int(screen.height * 0.55)
            let minW = 280
            let minH = 200
            surfacePanelWidth = CGFloat(max(dpData.width ?? defaultW, minW))
            surfacePanelHeight = CGFloat(max(dpData.height ?? defaultH, minH))
        } else {
            surfacePanelWidth = panelWidth
            surfacePanelHeight = 300
        }

        let isDynamicPage = if case .dynamicPage = surface.data { true } else { false }

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: surfacePanelWidth, height: surfacePanelHeight),
            styleMask: isDynamicPage
                ? [.titled, .closable, .miniaturizable, .resizable]
                : [.titled, .fullSizeContentView, .nonactivatingPanel, .utilityWindow, .hudWindow, .resizable],
            backing: .buffered,
            defer: false
        )

        panel.contentViewController = hostingController

        // Re-measure fittingSize for non-dynamic panels now that the view is attached to a window.
        // For dynamic pages, restore the intended size because setting contentViewController
        // resizes the panel to the hosting controller's fittingSize, which is nearly zero
        // for a WKWebView that hasn't loaded content yet.
        if case .dynamicPage = surface.data {
            panel.setContentSize(NSSize(width: surfacePanelWidth, height: surfacePanelHeight))
        } else if let fittingSize = panel.contentView?.fittingSize {
            let maxH = (NSScreen.main?.visibleFrame.height ?? 800) - 40
            let newHeight = min(max(fittingSize.height, 150), maxH)
            panel.setContentSize(NSSize(width: surfacePanelWidth, height: newHeight))
        }
        if isDynamicPage {
            // Normal window level for apps
        } else {
            panel.level = .floating
        }
        panel.isMovableByWindowBackground = true
        if isDynamicPage {
            panel.titleVisibility = .visible
            panel.titlebarAppearsTransparent = false
            panel.title = surface.title ?? "App"
        } else {
            panel.titleVisibility = .hidden
            panel.titlebarAppearsTransparent = true
        }
        panel.alphaValue = 0.95
        panel.isReleasedWhenClosed = false
        if isDynamicPage {
            panel.collectionBehavior = [.canJoinAllSpaces]
        } else {
            panel.collectionBehavior = [.canJoinAllSpaces, .stationary]
        }

        if case .dynamicPage = surface.data {
            panel.minSize = NSSize(width: 280, height: 200)
            panel.maxSize = NSSize(width: 1200, height: 10000)
        } else {
            panel.minSize = NSSize(width: 280, height: 100)
            panel.maxSize = NSSize(width: 600, height: 10000)
        }

        if isDynamicPage {
            let surfaceId = surface.id
            let observedPanel = panel
            let observer = NotificationCenter.default.addObserver(
                forName: NSWindow.willCloseNotification,
                object: panel,
                queue: .main
            ) { [weak self] _ in
                guard let self else { return }
                Task { @MainActor in
                    guard self.panels[surfaceId] === observedPanel else { return }
                    self.viewModels[surfaceId]?.onDismiss()
                }
            }
            closeObservers[surfaceId] = observer
        }

        panels[surface.id] = panel

        // Reposition all panels to ensure correct stacking after show/dismiss cycles.
        repositionAllPanels()

        panel.orderFront(nil)

        log.info("Showing surface: id=\(surface.id), type=\(surface.type.rawValue)")
    }

    // MARK: - Update

    func updateSurface(_ message: UiSurfaceUpdateMessage) {
        guard let existing = activeSurfaces[message.surfaceId] else {
            log.warning("Cannot update unknown surface: \(message.surfaceId)")
            return
        }

        guard let updated = existing.updated(with: message) else {
            log.error("Failed to parse updated data for surface: \(message.surfaceId)")
            return
        }

        activeSurfaces[message.surfaceId] = updated

        // If there's a coordinator and the update contains document-specific fields,
        // send the update directly to the web view via window.vellum.onContentUpdate()
        if let coordinator = surfaceCoordinators[message.surfaceId] {
            let dataDict = message.data.value as? [String: Any] ?? [:]
            if dataDict["markdown"] != nil || dataDict["updateMode"] != nil {
                coordinator.sendContentUpdate(dataDict)
                log.info("Sent content update to coordinator for surface: \(message.surfaceId)")
            }
        }

        if workspaceRoutedSurfaces.contains(message.surfaceId) {
            // Notify the workspace view so it can re-render with updated data.
            NotificationCenter.default.post(
                name: .updateDynamicWorkspace,
                object: nil,
                userInfo: ["surface": updated]
            )
        } else {
            // Update the existing view model so child views preserve their @State.
            viewModels[message.surfaceId]?.surface = updated
        }

        log.info("Updated surface: id=\(message.surfaceId)")
    }

    // MARK: - App Refresh

    /// Refresh the displayed surface for an app with freshly compiled HTML.
    /// Called when `app_files_changed` arrives and the affected app has an
    /// active surface. Updates the in-memory surface state and notifies the
    /// view layer so `updateNSView` picks up the new HTML via `reloadGeneration`.
    func refreshAppSurface(appId: String, html: String) {
        for (surfaceId, trackedAppId) in surfaceAppIds {
            guard trackedAppId == appId else { continue }
            guard let existing = activeSurfaces[surfaceId] else { continue }
            guard case .dynamicPage(let dpData) = existing.data else { continue }

            let updatedData = DynamicPageSurfaceData(
                html: html,
                width: dpData.width,
                height: dpData.height,
                appId: dpData.appId,
                dirName: dpData.dirName,
                appType: dpData.appType,
                preview: dpData.preview,
                reloadGeneration: (dpData.reloadGeneration ?? 0) + 1,
                status: dpData.status
            )

            let updated = Surface(
                id: existing.id,
                conversationId: existing.conversationId,
                type: existing.type,
                title: existing.title,
                data: .dynamicPage(updatedData),
                actions: existing.actions
            )

            activeSurfaces[surfaceId] = updated

            if workspaceRoutedSurfaces.contains(surfaceId) {
                NotificationCenter.default.post(
                    name: .updateDynamicWorkspace,
                    object: nil,
                    userInfo: ["surface": updated]
                )
            } else {
                viewModels[surfaceId]?.surface = updated
            }

            log.info("Refreshed app surface: surfaceId=\(surfaceId, privacy: .public) appId=\(appId, privacy: .public)")
        }
    }

    // MARK: - Dismiss

    func dismissSurface(_ message: UiSurfaceDismissMessage) {
        dismissSurfaceById(message.surfaceId)
    }

    /// Dismiss only floating panel surfaces, leaving workspace-routed surfaces untouched.
    /// Used by the global Escape handler to avoid destroying workspace apps when the user
    /// presses Escape in another application.
    func dismissFloatingOnly() {
        let floatingIds = Array(panels.keys).filter { !workspaceRoutedSurfaces.contains($0) }
        for id in floatingIds {
            dismissSurfaceById(id)
        }
    }

    func dismissAll() {
        for observer in closeObservers.values {
            NotificationCenter.default.removeObserver(observer)
        }
        closeObservers.removeAll()

        let hadWorkspaceRouted = !workspaceRoutedSurfaces.isEmpty

        let ids = Array(panels.keys)
        for id in ids {
            panels[id]?.close()
            panels.removeValue(forKey: id)
            viewModels.removeValue(forKey: id)
            activeSurfaces.removeValue(forKey: id)
            log.info("Dismissed surface: id=\(id)")
        }

        // Also clean up workspace-routed surfaces (no NSPanel to close).
        for id in workspaceRoutedSurfaces {
            activeSurfaces.removeValue(forKey: id)
            log.info("Dismissed workspace-routed surface: id=\(id)")
        }
        workspaceRoutedSurfaces.removeAll()

        surfaceOrder.removeAll()
        surfaceAppIds.removeAll()
        surfaceCoordinators.removeAll()
        respondedSurfaces.removeAll()

        if hadWorkspaceRouted {
            NotificationCenter.default.post(
                name: .dismissDynamicWorkspace,
                object: nil,
                userInfo: nil
            )
        }
    }

    private func dismissSurfaceById(_ surfaceId: String) {
        let wasWorkspaceRouted = workspaceRoutedSurfaces.remove(surfaceId) != nil

        if let observer = closeObservers.removeValue(forKey: surfaceId) {
            NotificationCenter.default.removeObserver(observer)
        }
        panels[surfaceId]?.close()
        panels.removeValue(forKey: surfaceId)
        viewModels.removeValue(forKey: surfaceId)
        activeSurfaces.removeValue(forKey: surfaceId)
        surfaceAppIds.removeValue(forKey: surfaceId)
        surfaceCoordinators.removeValue(forKey: surfaceId)
        respondedSurfaces.remove(surfaceId)
        surfaceOrder.removeAll { $0 == surfaceId }
        repositionAllPanels()

        if wasWorkspaceRouted {
            NotificationCenter.default.post(
                name: .dismissDynamicWorkspace,
                object: nil,
                userInfo: ["surfaceId": surfaceId]
            )
        }

        log.info("Dismissed surface: id=\(surfaceId)")
    }

    // MARK: - Data Response Routing

    /// Routes a data response from the daemon back to the correct WebView coordinator.
    func resolveDataResponse(surfaceId: String, response: AppDataResponseMessage) {
        guard let coordinator = surfaceCoordinators[surfaceId] else {
            let knownIds = Array(self.surfaceCoordinators.keys).joined(separator: ", ")
            log.error("resolveDataResponse: no coordinator for surfaceId=\(surfaceId). Known coordinators: [\(knownIds)]")
            return
        }
        log.info("Routing data response to coordinator: surfaceId=\(surfaceId), callId=\(response.callId), success=\(response.success)")
        coordinator.resolveDataResponse(response)
    }

    // MARK: - Positioning

    private func centerPanel(_ panel: NSPanel) {
        guard let screen = NSScreen.main else { return }
        let screenFrame = screen.visibleFrame
        let panelFrame = panel.frame

        let x = screenFrame.midX - panelFrame.width / 2
        let y = screenFrame.midY - panelFrame.height / 2

        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    private func positionPanel(_ panel: NSPanel, yOffset: CGFloat) {
        guard let screen = NSScreen.main else { return }
        let screenFrame = screen.visibleFrame

        let actualWidth = panel.frame.width

        let x = screenFrame.maxX - actualWidth - panelMargin
        let y = screenFrame.minY + panelMargin + yOffset

        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    /// Reposition all visible panels based on their order in `surfaceOrder`.
    /// Called after show and dismiss to prevent gaps and overlaps.
    private func repositionAllPanels() {
        var yOffset: CGFloat = 0
        for surfaceId in surfaceOrder {
            guard let panel = panels[surfaceId] else { continue }
            if case .dynamicPage = activeSurfaces[surfaceId]?.data {
                centerPanel(panel)
            } else {
                positionPanel(panel, yOffset: yOffset)
                yOffset += panel.frame.height + panelSpacing
            }
        }
    }
}
