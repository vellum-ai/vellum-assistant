import AppKit
import SwiftUI
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "SurfaceManager")

/// Observable view model that holds the current surface state.
/// Kept alive across updates so that child SwiftUI views preserve their @State (e.g. form inputs).
@MainActor
final class SurfaceViewModel: ObservableObject {
    @Published var surface: Surface
    let onAction: (String, [String: Any]?) -> Void
    let onDismiss: () -> Void
    let appId: String?
    let onDataRequest: ((String, String, String?, [String: Any]?) -> Void)?
    let onCoordinatorReady: ((DynamicPageSurfaceView.Coordinator) -> Void)?

    init(
        surface: Surface,
        onAction: @escaping (String, [String: Any]?) -> Void,
        onDismiss: @escaping () -> Void,
        appId: String? = nil,
        onDataRequest: ((String, String, String?, [String: Any]?) -> Void)? = nil,
        onCoordinatorReady: ((DynamicPageSurfaceView.Coordinator) -> Void)? = nil
    ) {
        self.surface = surface
        self.onAction = onAction
        self.onDismiss = onDismiss
        self.appId = appId
        self.onDataRequest = onDataRequest
        self.onCoordinatorReady = onCoordinatorReady
    }
}

/// Manages the lifecycle of surface windows (NSPanel) shown in response to daemon IPC messages.
///
/// Each surface is displayed in a floating, non-activating panel positioned at the bottom-right
/// of the screen, following the same window pattern as `AmbientSuggestionWindow`.
@MainActor
final class SurfaceManager: ObservableObject {

    // MARK: - Published State

    @Published var activeSurfaces: [String: Surface] = [:]

    // MARK: - Private State

    private var panels: [String: NSPanel] = [:]
    private var viewModels: [String: SurfaceViewModel] = [:]

    /// Tracks appId per surface for persistent app RPC routing.
    var surfaceAppIds: [String: String] = [:]

    /// Tracks Coordinator per surface for routing data responses back to WebView.
    var surfaceCoordinators: [String: DynamicPageSurfaceView.Coordinator] = [:]

    /// Ordered list of surface IDs for deterministic stacking positions.
    private var surfaceOrder: [String] = []

    /// Surfaces that have already sent an action to the daemon.
    /// Prevents duplicate actions (e.g. submit followed by dismiss) from racing.
    private var respondedSurfaces: Set<String> = []

    private let panelWidth: CGFloat = 380
    private let panelMargin: CGFloat = 20
    private let panelSpacing: CGFloat = 10

    // MARK: - Action Callback

    /// Called when a user interacts with a surface action button.
    /// Parameters: sessionId, surfaceId, actionId, optional data dictionary.
    var onAction: ((String, String, String, [String: Any]?) -> Void)?

    /// Called when a persistent app's JS makes a data request via the RPC bridge.
    /// Parameters: surfaceId, callId, method, appId, recordId, data.
    var onDataRequest: ((String, String, String, String, String?, [String: Any]?) -> Void)?

    // MARK: - Show

    func showSurface(_ message: UiSurfaceShowMessage) {
        guard let surface = Surface.from(message) else {
            log.error("Failed to parse surface from message: surfaceId=\(message.surfaceId), type=\(message.surfaceType)")
            return
        }

        // Dismiss any existing surface with the same ID first.
        if panels[surface.id] != nil {
            dismissSurfaceById(surface.id)
        }

        activeSurfaces[surface.id] = surface
        surfaceOrder.append(surface.id)

        // Extract and track appId for persistent app RPC routing.
        let dict = message.data.value as? [String: Any?] ?? [:]
        if let appId = dict["appId"] as? String {
            surfaceAppIds[surface.id] = appId
        }

        let appId = surfaceAppIds[surface.id]

        let viewModel = SurfaceViewModel(
            surface: surface,
            onAction: { [weak self] actionId, data in
                guard let self, !self.respondedSurfaces.contains(surface.id) else { return }
                self.respondedSurfaces.insert(surface.id)
                self.onAction?(surface.sessionId, surface.id, actionId, data)
            },
            onDismiss: { [weak self] in
                guard let self, !self.respondedSurfaces.contains(surface.id) else {
                    self?.dismissSurfaceById(surface.id)
                    return
                }
                self.respondedSurfaces.insert(surface.id)
                self.onAction?(surface.sessionId, surface.id, "dismiss", nil)
                self.dismissSurfaceById(surface.id)
            },
            appId: appId,
            onDataRequest: appId != nil ? { [weak self] callId, method, recordId, data in
                guard let appId = self?.surfaceAppIds[surface.id] else { return }
                self?.onDataRequest?(surface.id, callId, method, appId, recordId, data)
            } : nil,
            onCoordinatorReady: appId != nil ? { [weak self] coordinator in
                self?.surfaceCoordinators[surface.id] = coordinator
            } : nil
        )
        viewModels[surface.id] = viewModel

        let view = SurfaceContainerView(viewModel: viewModel)

        let hostingController = NSHostingController(rootView: view)

        let surfacePanelWidth: CGFloat
        let surfacePanelHeight: CGFloat
        if case .dynamicPage(let dpData) = surface.data {
            let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            surfacePanelWidth = CGFloat(dpData.width ?? Int(min(screen.width * 0.5, 800)))
            surfacePanelHeight = CGFloat(dpData.height ?? Int(min(screen.height * 0.75, 900)))
        } else {
            surfacePanelWidth = panelWidth
            surfacePanelHeight = 300
        }

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: surfacePanelWidth, height: surfacePanelHeight),
            styleMask: [.titled, .nonactivatingPanel, .utilityWindow, .hudWindow, .resizable],
            backing: .buffered,
            defer: false
        )

        panel.contentViewController = hostingController

        // Re-measure fittingSize for non-dynamic panels now that the view is attached to a window.
        if case .dynamicPage = surface.data {
            // Dynamic pages handle their own sizing via webView didFinish.
        } else if let fittingSize = panel.contentView?.fittingSize {
            let maxH = (NSScreen.main?.visibleFrame.height ?? 800) - 40
            let newHeight = min(max(fittingSize.height, 150), maxH)
            panel.setContentSize(NSSize(width: surfacePanelWidth, height: newHeight))
        }
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.alphaValue = 0.95
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]

        if case .dynamicPage = surface.data {
            panel.minSize = NSSize(width: 280, height: 200)
            panel.maxSize = NSSize(width: 1200, height: 10000)
        } else {
            panel.minSize = NSSize(width: 280, height: 100)
            panel.maxSize = NSSize(width: 600, height: 10000)
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

        // Update the existing view model so child views preserve their @State.
        viewModels[message.surfaceId]?.surface = updated

        log.info("Updated surface: id=\(message.surfaceId)")
    }

    // MARK: - Dismiss

    func dismissSurface(_ message: UiSurfaceDismissMessage) {
        dismissSurfaceById(message.surfaceId)
    }

    func dismissAll() {
        let ids = Array(panels.keys)
        for id in ids {
            panels[id]?.close()
            panels.removeValue(forKey: id)
            viewModels.removeValue(forKey: id)
            activeSurfaces.removeValue(forKey: id)
            log.info("Dismissed surface: id=\(id)")
        }
        surfaceOrder.removeAll()
        surfaceAppIds.removeAll()
        surfaceCoordinators.removeAll()
        respondedSurfaces.removeAll()
    }

    private func dismissSurfaceById(_ surfaceId: String) {
        panels[surfaceId]?.close()
        panels.removeValue(forKey: surfaceId)
        viewModels.removeValue(forKey: surfaceId)
        activeSurfaces.removeValue(forKey: surfaceId)
        surfaceAppIds.removeValue(forKey: surfaceId)
        surfaceCoordinators.removeValue(forKey: surfaceId)
        respondedSurfaces.remove(surfaceId)
        surfaceOrder.removeAll { $0 == surfaceId }
        repositionAllPanels()
        log.info("Dismissed surface: id=\(surfaceId)")
    }

    // MARK: - Data Response Routing

    /// Routes a data response from the daemon back to the correct WebView coordinator.
    func resolveDataResponse(surfaceId: String, response: AppDataResponseMessage) {
        surfaceCoordinators[surfaceId]?.resolveDataResponse(response)
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
