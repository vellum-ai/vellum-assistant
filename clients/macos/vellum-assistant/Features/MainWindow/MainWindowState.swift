import SwiftUI
import VellumAssistantShared

/// Cross-view UI state for the main window, extracted from `MainWindowView`
/// to make it explicit, injectable, and easier to preview.
@MainActor
final class MainWindowState: ObservableObject {
    @Published var activePanel: SidePanelType?
    @Published var isDynamicExpanded = false
    @Published var activeDynamicSurface: UiSurfaceShowMessage?
    @Published var activeDynamicParsedSurface: Surface?
    @Published var hasAPIKey: Bool
    @Published var workspaceComposerExpanded = false
    @Published var activityMessageId: UUID?
    @Published var layoutConfig: LayoutConfig

    init(hasAPIKey: Bool = APIKeyManager.hasAnyKey()) {
        self.hasAPIKey = hasAPIKey
        self.layoutConfig = LayoutConfigStore.load()
    }

    func toggleActivityPanel(with messageId: UUID) {
        if activePanel == .activity && activityMessageId == messageId {
            // Close if already open with the same message
            activePanel = nil
            activityMessageId = nil
        } else {
            // Open with new message or update to different message
            self.activityMessageId = messageId
            self.activePanel = .activity
        }
    }

    func togglePanel(_ panel: SidePanelType) {
        if activePanel == panel {
            activePanel = nil
        } else {
            activePanel = panel
        }
    }

    func refreshAPIKeyStatus(isConnected: Bool) {
        hasAPIKey = APIKeyManager.hasAnyKey() || isConnected
    }

    func applyLayoutConfig(_ wire: UiLayoutConfigMessage) {
        layoutConfig = LayoutConfig.merged(base: layoutConfig, wire: wire)
        LayoutConfigStore.save(layoutConfig)
    }

    /// Reset all dynamic workspace state. Callers should also reset
    /// view-local state like `showSharePicker` separately.
    func closeDynamicPanel() {
        activePanel = nil
        isDynamicExpanded = false
        activeDynamicSurface = nil
        activeDynamicParsedSurface = nil
    }

    func applyLayoutConfig(_ wire: UiLayoutConfigMessage) {
        layoutConfig = LayoutConfig.merged(base: layoutConfig, wire: wire)
        LayoutConfigStore.save(layoutConfig)
    }

    func resetLayout() {
        layoutConfig = .default
        LayoutConfigStore.save(layoutConfig)
    }
}
