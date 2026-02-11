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

    init(surface: Surface, onAction: @escaping (String, [String: Any]?) -> Void) {
        self.surface = surface
        self.onAction = onAction
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

    /// Ordered list of surface IDs for deterministic stacking positions.
    private var surfaceOrder: [String] = []

    private let panelWidth: CGFloat = 380
    private let panelMargin: CGFloat = 20
    private let panelSpacing: CGFloat = 10

    // MARK: - Action Callback

    /// Called when a user interacts with a surface action button.
    /// Parameters: sessionId, surfaceId, actionId, optional data dictionary.
    var onAction: ((String, String, String, [String: Any]?) -> Void)?

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

        let viewModel = SurfaceViewModel(
            surface: surface,
            onAction: { [weak self] actionId, data in
                self?.onAction?(surface.sessionId, surface.id, actionId, data)
            }
        )
        viewModels[surface.id] = viewModel

        let view = SurfaceContainerView(viewModel: viewModel)

        let hostingController = NSHostingController(rootView: view)

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: 140),
            styleMask: [.titled, .nonactivatingPanel, .utilityWindow, .hudWindow],
            backing: .buffered,
            defer: false
        )

        panel.contentViewController = hostingController
        panel.level = .floating
        panel.isMovableByWindowBackground = true
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.alphaValue = 0.95
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]

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
    }

    private func dismissSurfaceById(_ surfaceId: String) {
        panels[surfaceId]?.close()
        panels.removeValue(forKey: surfaceId)
        viewModels.removeValue(forKey: surfaceId)
        activeSurfaces.removeValue(forKey: surfaceId)
        surfaceOrder.removeAll { $0 == surfaceId }
        repositionAllPanels()
        log.info("Dismissed surface: id=\(surfaceId)")
    }

    // MARK: - Positioning

    private func positionPanel(_ panel: NSPanel, at index: Int) {
        guard let screen = NSScreen.main else { return }
        let screenFrame = screen.visibleFrame

        let estimatedPanelHeight: CGFloat = 140
        let yOffset = CGFloat(index) * (estimatedPanelHeight + panelSpacing)

        let x = screenFrame.maxX - panelWidth - panelMargin
        let y = screenFrame.minY + panelMargin + yOffset

        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    /// Reposition all visible panels based on their order in `surfaceOrder`.
    /// Called after show and dismiss to prevent gaps and overlaps.
    private func repositionAllPanels() {
        for (index, surfaceId) in surfaceOrder.enumerated() {
            if let panel = panels[surfaceId] {
                positionPanel(panel, at: index)
            }
        }
    }
}
