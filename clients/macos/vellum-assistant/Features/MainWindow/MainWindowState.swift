import SwiftUI
import VellumAssistantShared

/// Represents what is currently displayed in the main content area.
enum ViewSelection: Equatable {
    case thread(UUID)
    case app(String)  // app ID
    case appEditing(appId: String, threadId: UUID)
    case panel(SidePanelType)
}

/// Cross-view UI state for the main window, extracted from `MainWindowView`
/// to make it explicit, injectable, and easier to preview.
@MainActor
final class MainWindowState: ObservableObject {
    @AppStorage("lastActivePanel") private var lastActivePanelString: String?
    @AppStorage("homeBaseDashboardDefaultEnabled") private var homeBaseDashboardDefaultEnabled: Bool = false
    @AppStorage("chatDockOpen") private var chatDockOpen = false

    /// The single source of truth for what the main content area displays.
    @Published var selection: ViewSelection? {
        didSet {
            // When navigating to a thread, update the persistent thread tracker.
            // For overlays (app, appEditing, panel) and nil, leave persistentThreadId unchanged.
            if case .thread(let id) = selection {
                persistentThreadId = id
            }
        }
    }

    /// Tracks the "background" thread that persists even when viewing an app or panel overlay.
    @Published var persistentThreadId: UUID?

    @Published var selectedSubagentId: String?
    @Published var activeDynamicSurface: UiSurfaceShowMessage?
    @Published var activeDynamicParsedSurface: Surface?
    @Published var hasAPIKey: Bool
    @Published var workspaceComposerExpanded = false
    @Published var layoutConfig: LayoutConfig
    @Published var toastInfo: ToastInfo?

    // MARK: - Backward-Compatible Computed Properties

    /// Derived from `selection` for backward compatibility.
    var activePanel: SidePanelType? {
        get {
            switch selection {
            case .panel(let type): return type
            case .app, .appEditing: return .generated
            default: return nil
            }
        }
        set {
            if let panel = newValue {
                selection = .panel(panel)
            } else {
                // Only clear if currently showing a panel
                if case .panel = selection {
                    selection = nil
                } else if newValue == nil && activePanel != nil {
                    // Explicit nil set — clear selection
                    selection = nil
                }
            }
            // Persist the active panel
            if let newValue {
                lastActivePanelString = String(describing: newValue)
            } else if newValue == nil {
                lastActivePanelString = nil
            }
        }
    }

    /// Whether the main content area is showing a plain chat conversation
    /// (either an explicit `.thread` selection or `nil` which defaults to chat).
    var isShowingChat: Bool {
        switch selection {
        case .thread, .none: return true
        default: return false
        }
    }

    /// Whether the dynamic workspace (app view) is expanded.
    var isDynamicExpanded: Bool {
        get {
            switch selection {
            case .app, .appEditing: return true
            default: return false
            }
        }
        set {
            if !newValue {
                // Collapsing: if we were showing an app, clear
                if case .app = selection { selection = nil }
                if case .appEditing = selection { selection = nil }
            }
            // Setting to true is handled by setting selection to .app(...)
        }
    }

    /// Whether the chat dock is open alongside an app workspace.
    var isChatDockOpen: Bool {
        get {
            if case .appEditing = selection { return true }
            return false
        }
        set {
            if newValue {
                // No-op: callers should use setAppEditing(appId:threadId:) directly
                // since transitioning to .appEditing requires a thread ID.
            } else {
                // Closing chat dock: transition from .appEditing to .app
                if case .appEditing(let appId, _) = selection {
                    selection = .app(appId)
                }
            }
            chatDockOpen = newValue
        }
    }

    init(hasAPIKey: Bool = APIKeyManager.hasAnyKey()) {
        self.hasAPIKey = hasAPIKey
        self.layoutConfig = LayoutConfigStore.load()
    }

    // MARK: - Selection Helpers

    /// Dismiss the current overlay (app, panel, etc.) and return to the persistent thread.
    func dismissOverlay() {
        if let threadId = persistentThreadId {
            selection = .thread(threadId)
        } else {
            selection = nil
        }
    }

    func select(_ newSelection: ViewSelection) {
        selection = newSelection
    }

    /// Whether an app is currently shown (either standalone or editing)
    var activeAppId: String? {
        switch selection {
        case .app(let id): return id
        case .appEditing(let appId, _): return appId
        default: return nil
        }
    }

    /// Whether a thread is currently active (either standalone or editing alongside app)
    var activeEditingThreadId: UUID? {
        switch selection {
        case .thread(let id): return id
        case .appEditing(_, let threadId): return threadId
        default: return nil
        }
    }

    // MARK: - Panel Toggling

    func togglePanel(_ panel: SidePanelType) {
        if case .panel(let current) = selection, current == panel {
            selection = nil
        } else {
            selection = .panel(panel)
        }
        if case .panel(let p) = selection, p == panel {
            lastActivePanelString = String(describing: panel)
        } else {
            lastActivePanelString = nil
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
        selection = nil
        activeDynamicSurface = nil
        activeDynamicParsedSurface = nil
    }

    func toggleChatDock() {
        if case .appEditing(let appId, _) = selection {
            // Currently editing -> close chat dock
            selection = .app(appId)
            chatDockOpen = false
        } else if case .app(let appId) = selection {
            // Currently app only -> open chat dock (needs thread)
            // The view layer will wire the thread ID via setAppEditing
            // For now, mark intent by keeping .app and letting the view handle transition
            _ = appId
            chatDockOpen = true
        }
    }

    /// Transition to appEditing with a specific thread
    func setAppEditing(appId: String, threadId: UUID) {
        selection = .appEditing(appId: appId, threadId: threadId)
        chatDockOpen = true
    }

    func resetLayout() {
        layoutConfig = .default
        LayoutConfigStore.save(layoutConfig)
    }

    /// Show a toast notification in the main window.
    func showToast(message: String, style: ToastInfo.Style, primaryAction: VToastAction? = nil) {
        toastInfo = ToastInfo(message: message, style: style, primaryAction: primaryAction)
    }

    /// Dismiss the currently displayed toast.
    func dismissToast() {
        toastInfo = nil
    }

    /// Restore the last active panel from UserDefaults
    func restoreLastActivePanel() {
        // Dashboard-first mode should always bootstrap into Home Base rather than
        // resurrecting a stale side-panel route from a prior session.
        guard !homeBaseDashboardDefaultEnabled else { return }
        guard let savedPanelString = lastActivePanelString,
              let panel = SidePanelType(rawValue: savedPanelString) else { return }

        selection = .panel(panel)
    }
}

/// Data model for a toast notification displayed in the main window.
struct ToastInfo {
    enum Style {
        case success
        case error
    }

    let message: String
    let style: Style
    let primaryAction: VToastAction?
}
