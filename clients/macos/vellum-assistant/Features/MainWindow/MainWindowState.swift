import Combine
import Observation
import SwiftUI
import VellumAssistantShared

/// Represents what is currently displayed in the main content area.
enum ViewSelection: Equatable {
    case conversation(UUID)
    case app(String)  // app ID
    case appEditing(appId: String, conversationId: UUID)
    case panel(SidePanelType)
}

/// Cross-view UI state for the main window, extracted from `MainWindowView`
/// to make it explicit, injectable, and easier to preview.
@MainActor
public final class MainWindowState: ObservableObject {
    @AppStorage("lastActivePanel") private var lastActivePanelString: String?
    @AppStorage("isAppChatOpen") private var isAppChatOpen = false

    /// The single source of truth for what the main content area displays.
    let navigationHistory = NavigationHistory()

    /// Bridges `@Observable` NavigationHistory changes into this
    /// `ObservableObject`'s `objectWillChange` publisher so SwiftUI views
    /// observing this state also update when back/forward stacks change.

    /// Tracks the last known selection for navigation history recording.
    /// Captured at the start of `didSet` (before any side effects) to avoid
    /// relying on `oldValue` or `willSet` with `@Published`, which can
    /// behave unreliably.
    private var _lastKnownSelection: ViewSelection?

    @Published var selection: ViewSelection? {
        didSet {
            let previousSelection = _lastKnownSelection
            _lastKnownSelection = selection

            navigationHistory.recordTransition(from: previousSelection, to: selection, persistentConversationId: persistentConversationId)
            // When navigating to a conversation, update the persistent conversation tracker.
            // For overlays (app, appEditing, panel) and nil, leave persistentConversationId unchanged.
            if case .conversation(let id) = selection {
                persistentConversationId = id
            }
            // Clear persisted panel so app restart lands on the latest chat, not a stale panel.
            if case .conversation = selection { lastActivePanelString = nil }
            else if selection == nil { lastActivePanelString = nil }
            // Chat dock is only relevant inside app views. Clear it when
            // navigating away so other pages never show a stale split layout.
            switch selection {
            case .app, .appEditing: break
            default: isAppChatOpen = false
            }
        }
    }

    /// Tracks the "background" conversation that persists even when viewing an app or panel overlay.
    @Published var persistentConversationId: UUID?

    /// Tracks which panel originated the avatar customization flow so we can return to it.
    @Published var avatarCustomizationReturnPanel: SidePanelType = .intelligence

    @Published var selectedSubagentId: String?

    /// Transient memory ID to deep-link into when the Intelligence panel opens.
    /// Consumed once by IntelligencePanel/MemoriesPanel, then set back to nil.
    @Published var pendingMemoryId: String?
    @Published var activeDynamicSurface: UiSurfaceShowMessage?
    @Published var activeDynamicParsedSurface: Surface?
    @Published var workspaceComposerExpanded = false
    @Published var layoutConfig: LayoutConfig
    @Published var toastInfo: ToastInfo?
    @Published var imageLightbox: ImageLightboxState?
    private var autoDismissTask: Task<Void, Never>?
    private var lightboxFetchTask: Task<Void, Never>?

    /// Whether the main content area is showing a plain, full-window chat
    /// (either an explicit `.conversation` selection or `nil` which defaults to chat).
    ///
    /// This is **narrower** than ``isConversationVisible``: it excludes panels
    /// (including the document editor) and app-editing mode, even when those
    /// layouts contain a chat pane. Use ``isConversationVisible`` when you need
    /// to know whether *any* conversation UI is on screen.
    var isShowingChat: Bool {
        switch selection {
        case .conversation, .none: return true
        default: return false
        }
    }

    /// Whether a conversation is visible — true for conversation mode,
    /// app-editing mode (which shows a chat dock alongside the app),
    /// and panel mode when the chat bubble is enabled (split-view with
    /// a live conversation alongside the panel).
    public var isConversationVisible: Bool {
        switch selection {
        case .conversation, .none, .appEditing: return true
        case .panel(let panelType):
            // Document editor has a dedicated layout that always includes chat;
            // other panels show chat only when the chat bubble toggle is active.
            switch panelType {
            case .documentEditor: return true
            default: return isAppChatOpen
            }
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
            if !newValue, case .appEditing(let appId, _) = selection {
                selection = .app(appId)
            }
        }
    }

    init() {
        self.layoutConfig = LayoutConfigStore.load()
        observeNavigationHistory()
    }

    private func observeNavigationHistory() {
        withObservationTracking {
            _ = navigationHistory.backStack
            _ = navigationHistory.forwardStack
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                self?.objectWillChange.send()
                self?.observeNavigationHistory() // re-arm
            }
        }
    }

    // MARK: - Selection Helpers

    /// Dismiss the current overlay (app, panel, etc.) and return to the persistent conversation.
    func dismissOverlay() {
        if let conversationId = persistentConversationId {
            selection = .conversation(conversationId)
        } else {
            selection = nil
        }
    }

    func select(_ newSelection: ViewSelection) {
        selection = newSelection
    }

    func navigateBack() {
        guard let destination = navigationHistory.popBack(
            currentSelection: selection,
            persistentConversationId: persistentConversationId
        ) else { return }
        navigationHistory.withRecordingSuppressed {
            switch destination {
            case .selection(let viewSelection):
                self.selection = viewSelection
            case .chatDefault(let conversationSnapshot):
                self.persistentConversationId = conversationSnapshot
                if let conversationId = conversationSnapshot {
                    self.selection = .conversation(conversationId)
                } else {
                    self.selection = nil
                }
            }
        }
    }

    func navigateForward() {
        guard let destination = navigationHistory.popForward(
            currentSelection: selection,
            persistentConversationId: persistentConversationId
        ) else { return }
        navigationHistory.withRecordingSuppressed {
            switch destination {
            case .selection(let viewSelection):
                self.selection = viewSelection
            case .chatDefault(let conversationSnapshot):
                self.persistentConversationId = conversationSnapshot
                if let conversationId = conversationSnapshot {
                    self.selection = .conversation(conversationId)
                } else {
                    self.selection = nil
                }
            }
        }
    }

    func applySelectionCorrection(_ newSelection: ViewSelection?) {
        navigationHistory.withRecordingSuppressed {
            self.selection = newSelection
        }
    }

    /// Whether an app is currently shown (either standalone or editing)
    var activeAppId: String? {
        switch selection {
        case .app(let id): return id
        case .appEditing(let appId, _): return appId
        default: return nil
        }
    }

    /// Whether a conversation is currently active (either standalone or editing alongside app)
    var activeEditingConversationId: UUID? {
        switch selection {
        case .conversation(let id): return id
        case .appEditing(_, let conversationId): return conversationId
        default: return nil
        }
    }

    // MARK: - Panel Navigation

    func showPanel(_ panel: SidePanelType) {
        selection = .panel(panel)
        lastActivePanelString = String(describing: panel)
    }

    /// Navigate to the Intelligence panel and deep-link to a specific memory.
    func showMemory(id: String) {
        pendingMemoryId = id
        showPanel(.intelligence)
    }

    func applyLayoutConfig(_ wire: UiLayoutConfigMessage) {
        layoutConfig = LayoutConfig.merged(base: layoutConfig, wire: wire)
        LayoutConfigStore.save(layoutConfig)
    }

    func clearDynamicWorkspaceState() {
        activeDynamicSurface = nil
        activeDynamicParsedSurface = nil
    }

    /// Reset all dynamic workspace state. Callers should also reset
    /// view-local state like `showSharePicker` separately.
    func closeDynamicPanel() {
        selection = nil
        clearDynamicWorkspaceState()
    }

    /// Transition to appEditing with a specific conversation
    func setAppEditing(appId: String, conversationId: UUID) {
        selection = .appEditing(appId: appId, conversationId: conversationId)
    }

    func resetLayout() {
        layoutConfig = .default
        LayoutConfigStore.save(layoutConfig)
    }

    /// Show a toast notification in the main window.
    ///
    /// Auto-dismiss behaviour (default 4 s) applies to `.success` toasts
    /// that have no `primaryAction`. All other toasts require manual
    /// dismissal unless an explicit `autoDismissDelay` is provided.
    ///
    /// - Parameters:
    ///   - autoDismissDelay: Seconds before auto-dismiss. Pass `nil` to
    ///     require manual dismissal, or omit to use the default heuristic.
    ///   - onDismiss: Optional callback invoked when the toast is dismissed
    ///     by the user (via the X button) or by the auto-dismiss timer.
    /// - Returns: The unique ID of the displayed toast, useful for targeted dismissal.
    @discardableResult
    func showToast(message: String, style: ToastInfo.Style, copyableDetail: String? = nil, primaryAction: VToastAction? = nil, autoDismissDelay: TimeInterval? = .defaultForToast, onDismiss: (() -> Void)? = nil) -> UUID {
        autoDismissTask?.cancel()
        autoDismissTask = nil

        let toast = ToastInfo(message: message, style: style, copyableDetail: copyableDetail, primaryAction: primaryAction, onDismiss: onDismiss)
        toastInfo = toast

        // Resolve the effective delay: the sentinel value means "use the
        // default heuristic", an explicit nil means "never auto-dismiss",
        // and any positive value is used as-is.
        let effectiveDelay: TimeInterval?
        if autoDismissDelay == .defaultForToast {
            effectiveDelay = (style == .success && primaryAction == nil) ? 4 : nil
        } else {
            effectiveDelay = autoDismissDelay
        }

        if let delay = effectiveDelay {
            let toastId = toast.id
            autoDismissTask = Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                guard !Task.isCancelled else { return }
                self?.dismissToast(id: toastId)
            }
        }

        return toast.id
    }

    /// Dismiss the currently displayed toast, invoking its onDismiss callback.
    func dismissToast() {
        autoDismissTask?.cancel()
        autoDismissTask = nil
        let callback = toastInfo?.onDismiss
        toastInfo = nil
        callback?()
    }

    /// Dismiss the toast only if it matches the given ID.
    /// Prevents deferred callbacks from accidentally dismissing a different toast.
    func dismissToast(id: UUID) {
        guard toastInfo?.id == id else { return }
        dismissToast()
    }

    // MARK: - Image Lightbox

    /// Show the in-app image lightbox. For lazy-loaded attachments, pass the
    /// `lazyAttachmentId` and the thumbnail image — full-res data will be
    /// fetched asynchronously and swapped in when ready.
    func showImageLightbox(
        image: NSImage,
        filename: String,
        base64Data: String? = nil,
        lazyAttachmentId: String? = nil
    ) {
        lightboxFetchTask?.cancel()
        imageLightbox = ImageLightboxState(
            image: image,
            filename: filename,
            base64Data: base64Data,
            lazyAttachmentId: lazyAttachmentId,
            fullResImage: nil,
            isLoadingFullRes: lazyAttachmentId != nil
        )
        if lazyAttachmentId != nil {
            fetchFullResLightboxImage()
        }
    }

    func dismissImageLightbox() {
        lightboxFetchTask?.cancel()
        imageLightbox = nil
    }

    private func fetchFullResLightboxImage() {
        guard let attachmentId = imageLightbox?.lazyAttachmentId else { return }
        lightboxFetchTask = Task { @MainActor [weak self] in
            let data = try? await AttachmentContentClient.fetchContent(attachmentId: attachmentId)
            guard !Task.isCancelled else { return }
            if let data, let fullRes = NSImage(data: data) {
                self?.imageLightbox?.fullResImage = fullRes
                // Update base64Data so toolbar actions (copy, save) use full-res
                // We don't have a direct setter, but fullResImage is preferred by displayImage
            }
            self?.imageLightbox?.isLoadingFullRes = false
        }
    }

    /// Restore the last active panel from UserDefaults
    func restoreLastActivePanel() {
        guard let savedPanelString = lastActivePanelString,
              let panel = SidePanelType(rawValue: savedPanelString) else { return }
        navigationHistory.withRecordingSuppressed {
            selection = .panel(panel)
        }
    }
}

// MARK: - Toast auto-dismiss sentinel

extension Optional where Wrapped == TimeInterval {
    /// Sentinel that tells `showToast` to apply its default heuristic
    /// (auto-dismiss `.success` toasts without a `primaryAction`).
    static let defaultForToast: TimeInterval? = -.infinity
}

/// Data model for a toast notification displayed in the main window.
struct ToastInfo {
    enum Style {
        case success
        case error
        case warning
    }

    let id: UUID
    let message: String
    let style: Style
    let copyableDetail: String?
    let primaryAction: VToastAction?
    /// Called when the toast is dismissed via the X button (not via primary action).
    let onDismiss: (() -> Void)?

    init(message: String, style: Style, copyableDetail: String? = nil, primaryAction: VToastAction? = nil, onDismiss: (() -> Void)? = nil) {
        self.id = UUID()
        self.message = message
        self.style = style
        self.copyableDetail = copyableDetail
        self.primaryAction = primaryAction
        self.onDismiss = onDismiss
    }
}
