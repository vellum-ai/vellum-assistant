import AppKit
import SwiftUI
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "SurfaceManager")

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

    /// Vertical offset counter to stack multiple surfaces.
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

        let view = SurfacePlaceholderView(
            surface: surface,
            onAction: { [weak self] actionId, data in
                self?.onAction?(surface.sessionId, surface.id, actionId, data)
            }
        )

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

        // Position bottom-right of screen, stacked above existing panels.
        positionPanel(panel)

        panel.orderFront(nil)
        panels[surface.id] = panel

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

        // Rebuild the view in the existing panel.
        guard let panel = panels[message.surfaceId] else { return }

        let view = SurfacePlaceholderView(
            surface: updated,
            onAction: { [weak self] actionId, data in
                self?.onAction?(updated.sessionId, updated.id, actionId, data)
            }
        )

        panel.contentViewController = NSHostingController(rootView: view)

        log.info("Updated surface: id=\(message.surfaceId)")
    }

    // MARK: - Dismiss

    func dismissSurface(_ message: UiSurfaceDismissMessage) {
        dismissSurfaceById(message.surfaceId)
    }

    func dismissAll() {
        let ids = Array(panels.keys)
        for id in ids {
            dismissSurfaceById(id)
        }
    }

    private func dismissSurfaceById(_ surfaceId: String) {
        panels[surfaceId]?.close()
        panels.removeValue(forKey: surfaceId)
        activeSurfaces.removeValue(forKey: surfaceId)
        log.info("Dismissed surface: id=\(surfaceId)")
    }

    // MARK: - Positioning

    private func positionPanel(_ panel: NSPanel) {
        guard let screen = NSScreen.main else { return }
        let screenFrame = screen.visibleFrame

        // Count existing panels to determine vertical offset for stacking.
        let existingCount = panels.count
        let estimatedPanelHeight: CGFloat = 140
        let yOffset = CGFloat(existingCount) * (estimatedPanelHeight + panelSpacing)

        let x = screenFrame.maxX - panelWidth - panelMargin
        let y = screenFrame.minY + panelMargin + yOffset

        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }
}

// MARK: - Placeholder View

/// Temporary placeholder view for surfaces. The actual type-specific renderers will be
/// added in M4. This view displays the surface title, type, and action buttons using
/// the project's design system.
private struct SurfacePlaceholderView: View {
    let surface: Surface
    let onAction: (String, [String: Any]?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Header
            HStack(spacing: VSpacing.md) {
                Image(systemName: iconName)
                    .foregroundStyle(VColor.accent)
                Text(surface.title ?? surface.type.rawValue.capitalized)
                    .font(VFont.heading)
                    .foregroundStyle(VColor.textPrimary)
                Spacer()
            }

            // Type badge
            Text(surface.type.rawValue.uppercased())
                .font(VFont.small)
                .foregroundStyle(VColor.textMuted)

            // Actions
            if !surface.actions.isEmpty {
                HStack(spacing: VSpacing.md) {
                    Spacer()
                    ForEach(surface.actions) { action in
                        VButton(
                            label: action.label,
                            style: buttonStyle(for: action.style)
                        ) {
                            onAction(action.id, nil)
                        }
                    }
                }
            }
        }
        .padding(VSpacing.xl)
        .frame(width: 380)
        .vPanelBackground()
    }

    private var iconName: String {
        switch surface.type {
        case .card: return "rectangle.portrait"
        case .form: return "doc.text"
        case .list: return "list.bullet"
        case .confirmation: return "exclamationmark.triangle.fill"
        }
    }

    private func buttonStyle(for style: SurfaceActionStyle) -> VButton.Style {
        switch style {
        case .primary: return .primary
        case .secondary: return .ghost
        case .destructive: return .danger
        }
    }
}
