import SwiftUI
import VellumAssistantShared

/// Cross-view UI state for the main window, extracted from `MainWindowView`
/// to make it explicit, injectable, and easier to preview.
@MainActor
final class MainWindowState: ObservableObject {
    @AppStorage("lastActivePanel") private var lastActivePanelString: String?
    @AppStorage("homeBaseDashboardDefaultEnabled") private var homeBaseDashboardDefaultEnabled: Bool = false
    @AppStorage("chatDockOpen") private var chatDockOpen = false
    @Published var activePanel: SidePanelType? {
        didSet {
            // Persist non-activity panels only (activity is message-specific)
            if let activePanel, activePanel != .activity {
                lastActivePanelString = String(describing: activePanel)
            } else if activePanel == nil {
                lastActivePanelString = nil
            }
        }
    }
    @Published var isDynamicExpanded = false
    @Published var activeDynamicSurface: UiSurfaceShowMessage?
    @Published var activeDynamicParsedSurface: Surface?
    @Published var hasAPIKey: Bool
    @Published var workspaceComposerExpanded = false
    @Published var isChatDockOpen = UserDefaults.standard.bool(forKey: "chatDockOpen") {
        didSet { chatDockOpen = isChatDockOpen }
    }
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

    func toggleChatDock() {
        isChatDockOpen.toggle()
    }

    func resetLayout() {
        layoutConfig = .default
        LayoutConfigStore.save(layoutConfig)
    }

    /// Restore the last active panel from UserDefaults
    func restoreLastActivePanel() {
        // Dashboard-first mode should always bootstrap into Home Base rather than
        // resurrecting a stale side-panel route from a prior session.
        guard !homeBaseDashboardDefaultEnabled else { return }
        guard let savedPanelString = lastActivePanelString,
              let panel = SidePanelType(rawValue: savedPanelString) else { return }

        // Don't restore activity panel (it's session-specific)
        guard panel != .activity else { return }

        activePanel = panel
    }
}
