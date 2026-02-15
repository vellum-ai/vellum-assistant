import SwiftUI
import VellumAssistantShared

/// Which top-level content the main window displays.
enum ContentMode: String, CaseIterable {
    case dashboard
    case chat
}

/// Cross-view UI state for the main window, extracted from `MainWindowView`
/// to make it explicit, injectable, and easier to preview.
@MainActor
final class MainWindowState: ObservableObject {
    @Published var contentMode: ContentMode = .dashboard
    @Published var activePanel: SidePanelType?
    @Published var isDynamicExpanded = false
    @Published var activeDynamicSurface: UiSurfaceShowMessage?
    @Published var activeDynamicParsedSurface: Surface?
    @Published var hasAPIKey: Bool
    @Published var workspaceComposerExpanded = false
    @Published var activityToolCalls: [ToolCallData] = []
    /// Whether the chat is popped out into its own window.
    @Published var isChatPoppedOut = false

    init(hasAPIKey: Bool = APIKeyManager.hasAnyKey()) {
        self.hasAPIKey = hasAPIKey
    }

    func toggleActivityPanel(with toolCalls: [ToolCallData]) {
        if activePanel == .activity {
            // Close if already open
            activePanel = nil
        } else {
            // Open with new tool calls
            self.activityToolCalls = toolCalls
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

    /// Reset all dynamic workspace state. Callers should also reset
    /// view-local state like `showSharePicker` separately.
    func closeDynamicPanel() {
        activePanel = nil
        isDynamicExpanded = false
        activeDynamicSurface = nil
        activeDynamicParsedSurface = nil
    }
}
