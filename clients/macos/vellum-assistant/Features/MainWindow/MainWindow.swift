import AppKit
import Combine
import VellumAssistantShared
import SwiftUI

/// Delegate that intercepts the window close button to hide the window
/// instead of closing it, keeping the app running in the dock + menu bar.
/// The dock icon stays visible (with the assistant's avatar) so the user
/// can click it to re-open the window. The dock icon only disappears on
/// explicit disconnect (logout, retire, switch assistant).
@MainActor
private class MainWindowCloseDelegate: NSObject, NSWindowDelegate {
    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        return false
    }
}

/// NSWindow subclass that restores double-click-to-zoom on the title bar
/// and provides keystroke-redirect and composer-blur behaviors.
///
/// With `fullSizeContentView` + `titlebarAppearsTransparent`, the system
/// title bar becomes invisible and stops handling double-clicks. This
/// subclass detects double-clicks in the title bar zone and performs the
/// action configured in System Settings (zoom or minimize).
///
/// We manually track the pre-zoom frame because `NSWindow.isZoomed` can be
/// unreliable with `fullSizeContentView`, causing `zoom(nil)` not to toggle
/// back to the previous size.
///
/// Composer blur (click-outside-to-dismiss) is handled via
/// `NSEvent.addLocalMonitorForEvents` rather than overriding `sendEvent`,
/// which avoids interfering with SwiftUI's internal gesture dispatch and
/// prevents use-after-free crashes in `ButtonGesture` on macOS 26.
///
/// Keep custom AppKit event/view subclasses actor-isolated so SwiftUI
/// gesture callbacks always execute with main-executor context.
@MainActor
class TitleBarZoomableWindow: NSWindow {
    private var preZoomFrame: NSRect?

    /// Callback to redirect typing to the SwiftUI composer when no text view
    /// is focused. The handler receives the character string to insert.
    var composerRedirectHandler: ((String) -> Void)?

    /// Weak reference to the outermost NSView that contains the entire composer
    /// UI (text field + action buttons). Used for hit-testing blur dismissal so
    /// clicks on sibling controls (Attach, Mic, Send) aren't treated as outside.
    weak var composerContainerView: NSView?

    /// When true, `keyDown` will not auto-redirect keystrokes to the composer.
    /// Set when the user clicks outside the composer to dismiss focus; cleared
    /// when the composer regains focus (e.g. user clicks back into it) or when
    /// the app is reactivated (cmd+tab / Dock click).
    private(set) var composerDismissed = false

    /// Set on `didResignActiveNotification` so `becomeKey` can distinguish
    /// app reactivation (cmd+tab / Dock click) from an in-app window change
    /// (e.g. command palette or sheet dismiss).
    private var appWasDeactivated = false
    private var notificationObservers: [Any] = []
    private var eventMonitors: [Any] = []

    func clearComposerDismissed() {
        composerDismissed = false
    }

    override func becomeKey() {
        super.becomeKey()
        // Re-enable keystroke redirect only on app reactivation, not when
        // a secondary window closes within the already-active app.
        if appWasDeactivated {
            appWasDeactivated = false
            composerDismissed = false
        }
    }

    /// Subscribe to app activation lifecycle and install event monitors.
    /// Idempotent — safe to call more than once.
    func observeAppActivation() {
        guard notificationObservers.isEmpty else { return }
        notificationObservers.append(
            NotificationCenter.default.addObserver(
                forName: NSApplication.didResignActiveNotification,
                object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.appWasDeactivated = true
                }
            }
        )

        // Monitor left-clicks to dismiss composer focus when the user clicks
        // outside the composer container. Uses DispatchQueue.main.async so
        // the blur runs after the event has been fully dispatched, preserving
        // the same dispatch-then-blur ordering.
        if let monitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown, handler: { [weak self] event in
            DispatchQueue.main.async { @MainActor in
                guard let self,
                      event.window === self,
                      let responder = self.firstResponder as? NSView,
                      let container = self.composerContainerView,
                      responder.isDescendant(of: container) else { return }
                let point = container.convert(event.locationInWindow, from: nil)
                if !container.bounds.contains(point) {
                    self.composerDismissed = true
                    self.makeFirstResponder(nil)
                }
            }
            return event
        }) {
            eventMonitors.append(monitor)
        }
    }

    /// Remove all notification observers and event monitors installed by
    /// `observeAppActivation()`. Idempotent — safe to call more than once.
    /// Called by `MainWindow.detachWindow()` when the window is reused for
    /// auth, and again by `deinit` as a safety net.
    func removeObservers() {
        for observer in notificationObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        notificationObservers.removeAll()
        for monitor in eventMonitors {
            NSEvent.removeMonitor(monitor)
        }
        eventMonitors.removeAll()
    }

    deinit {
        // Inline cleanup instead of calling removeObservers() because deinit
        // is nonisolated and cannot call @MainActor-isolated methods (SE-0371).
        // Stored property access is allowed in deinit. If removeObservers()
        // was already called by detachWindow(), these arrays are empty.
        for observer in notificationObservers {
            NotificationCenter.default.removeObserver(observer)
        }
        for monitor in eventMonitors {
            NSEvent.removeMonitor(monitor)
        }
    }

    override func keyDown(with event: NSEvent) {
        // If a text view is already focused, let it handle the event normally.
        if firstResponder is NSTextView {
            super.keyDown(with: event)
            return
        }

        // Don't auto-redirect if the user explicitly dismissed the composer.
        if composerDismissed {
            super.keyDown(with: event)
            return
        }

        // Only redirect plain characters (no Command/Control modifiers).
        let modifiers = event.modifierFlags.intersection([.command, .control])
        guard modifiers.isEmpty,
              let chars = event.characters, !chars.isEmpty else {
            super.keyDown(with: event)
            return
        }

        // Skip non-character keys: Escape, Tab, arrow keys, function keys, etc.
        let kc = event.keyCode
        let isNonCharacter = kc == 53 // Escape
            || kc == 48 // Tab
            || kc == 36 || kc == 76 // Return/Enter
            || (kc >= 122 && kc <= 127) // F1-F6
            || (kc >= 96 && kc <= 103) // F5-F12 (extended)
            || kc == 105 || kc == 107 || kc == 113 || kc == 111 // F13-F16
            || (kc >= 123 && kc <= 126) // Arrow keys
        if isNonCharacter {
            super.keyDown(with: event)
            return
        }

        // Redirect to the SwiftUI composer via callback.
        if let handler = composerRedirectHandler {
            handler(chars)
            return
        }

        super.keyDown(with: event)
    }

    override func mouseUp(with event: NSEvent) {
        super.mouseUp(with: event)
        guard event.clickCount == 2 else { return }

        // Check if the click landed in the title bar zone (above contentLayoutRect)
        let clickY = event.locationInWindow.y
        guard clickY >= contentLayoutRect.maxY else { return }

        // Respect "Double-click a window's title bar to" system preference
        let action = UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") ?? "Maximize"
        switch action {
        case "Minimize":
            miniaturize(nil)
        case "None":
            break
        default: // "Maximize"
            if let savedFrame = preZoomFrame {
                // Restore to pre-zoom frame
                preZoomFrame = nil
                setFrame(savedFrame, display: true, animate: true)
            } else {
                // Save current frame and zoom
                preZoomFrame = frame
                zoom(nil)
            }
        }
    }
}

/// NSHostingController subclass whose view returns `mouseDownCanMoveWindow = false`.
/// This prevents the transparent title bar from swallowing clicks intended for
/// SwiftUI buttons (sidebar toggle, temporary-chat toggle) that sit in the
/// title bar zone.
@MainActor
class NonDraggableHostingController<Content: View>: NSHostingController<Content> {
    override func viewDidLoad() {
        super.viewDidLoad()
        // Recursively ensure the hosting view itself won't start a window drag
        disableDragging(in: view)
    }

    private func disableDragging(in view: NSView) {
        // The hosting view is private, so we swap it with a wrapper
        // that overrides mouseDownCanMoveWindow.
    }

    override func loadView() {
        super.loadView()
        // Replace the default hosting view with our non-draggable subclass
        let wrapper = NonDraggableContainerView()
        wrapper.translatesAutoresizingMaskIntoConstraints = false

        // Re-parent the hosting view's content into our wrapper
        let hostingView = self.view
        wrapper.addSubview(hostingView)
        hostingView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            hostingView.leadingAnchor.constraint(equalTo: wrapper.leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: wrapper.trailingAnchor),
            hostingView.topAnchor.constraint(equalTo: wrapper.topAnchor),
            hostingView.bottomAnchor.constraint(equalTo: wrapper.bottomAnchor),
        ])
        self.view = wrapper
    }
}

/// A plain NSView that returns `mouseDownCanMoveWindow = false`,
/// preventing the transparent title bar from intercepting clicks.
@MainActor
private class NonDraggableContainerView: NSView {
    override var mouseDownCanMoveWindow: Bool { false }
}

@MainActor
public final class MainWindow {
    private let services: AppServices
    private var window: NSWindow?
    let conversationManager: ConversationManager
    let appListManager = AppListManager()
    let traceStore = TraceStore()
    let usageDashboardStore: UsageDashboardStore
    public let windowState = MainWindowState()
    let documentManager = DocumentManager()
    private let assistantFeatureFlagStore: AssistantFeatureFlagStore
    var onMicrophoneToggle: (() -> Void)?
    let voiceModeManager = VoiceModeManager()
    let updateManager: UpdateManager

    /// Retained delegate that intercepts the close button to hide the window.
    private let closeDelegate = MainWindowCloseDelegate()

    /// Wake-up greeting to auto-send after the "coming alive" transition completes.
    /// Set by AppDelegate on first launch; consumed by MainWindowView.
    var pendingWakeUpMessage: String?

    /// Callback fired after the wake-up message is actually dispatched (not just
    /// queued). AppDelegate uses this to defer the bootstrap state transition to
    /// `.pendingFirstReply` until the message has truly been sent, avoiding a gap
    /// between window creation and actual send that could leave bootstrap stuck.
    var onWakeUpSent: (() -> Void)?

    // Forwarding accessors — keeps existing references working while
    // ownership lives in the `services` container.
    private var connectionManager: GatewayConnectionManager { services.connectionManager }
    private var eventStreamClient: EventStreamClient { services.connectionManager.eventStreamClient }
    private var surfaceManager: SurfaceManager { services.surfaceManager }
    private var ambientAgent: AmbientAgent { services.ambientAgent }
    private var zoomManager: ZoomManager { services.zoomManager }

    /// Tracks daemon reconnects so trace state can be reset on stream restart.
    private var connectionObservationTask: Task<Void, Never>?
    /// Tracks changes to `SettingsStore.userTimezone` so the usage dashboard
    /// re-fetches with the new timezone when the user changes it in settings.
    private var userTimezoneCancellable: AnyCancellable?
    private var layoutObserver: NSObjectProtocol?
    private var defaultTrafficLightOrigin: NSPoint?
    private var hasConnectedOnce = false

    /// Whether the main window is currently visible on screen.
    var isVisible: Bool {
        window?.isVisible ?? false
    }

    /// The active ChatViewModel from the current conversation, if any.
    var activeViewModel: ChatViewModel? {
        conversationManager.activeViewModel
    }

    init(
        services: AppServices,
        updateManager: UpdateManager,
        assistantFeatureFlagStore: AssistantFeatureFlagStore,
        isFirstLaunch: Bool = false,
        preChatContext: PreChatOnboardingContext? = nil
    ) {
        self.services = services
        self.updateManager = updateManager
        self.assistantFeatureFlagStore = assistantFeatureFlagStore
        self.conversationManager = ConversationManager(
            connectionManager: services.connectionManager,
            eventStreamClient: services.connectionManager.eventStreamClient,
            isFirstLaunch: isFirstLaunch,
            preChatContext: preChatContext
        )
        self.usageDashboardStore = UsageDashboardStore()
        self.usageDashboardStore.updateTimezone(services.settingsStore.userTimezone)
        self.conversationManager.ambientAgent = services.ambientAgent
        documentManager.connectionManager = connectionManager
        Task { @MainActor [weak self] in
            guard let self else { return }
            for await message in self.eventStreamClient.subscribe() {
                switch message {
                case .traceEvent(let msg):
                    self.traceStore.ingest(msg)
                case .usageUpdate:
                    self.usageDashboardStore.reset()
                default:
                    break
                }
            }
        }
        observeDaemonReconnects()
        observeUserTimezoneChanges()
    }

    /// Keep `UsageDashboardStore.resolvedTimezone` in sync with the user's
    /// configured timezone in Settings. When the user updates or clears the
    /// setting, the store resets and re-fetches on the next render.
    private func observeUserTimezoneChanges() {
        userTimezoneCancellable = services.settingsStore.$userTimezone
            .dropFirst()
            .removeDuplicates()
            .sink { [weak self] newIdentifier in
                self?.usageDashboardStore.updateTimezone(newIdentifier)
            }
    }

    /// Reset trace state when the daemon reconnects after a disconnect.
    /// The trace event stream is ephemeral; a reconnect means the daemon
    /// restarted and any in-flight trace context is stale.
    private func observeDaemonReconnects() {
        connectionObservationTask?.cancel()
        connectionObservationTask = Task { @MainActor [weak self] in
            var lastConnected = self?.connectionManager.isConnected ?? false
            while !Task.isCancelled {
                guard let self else { break }
                await withCheckedContinuation { (resume: CheckedContinuation<Void, Never>) in
                    withObservationTracking {
                        _ = self.connectionManager.isConnected
                    } onChange: {
                        resume.resume()
                    }
                }
                guard !Task.isCancelled, let self else { break }
                let connected = self.connectionManager.isConnected
                guard connected != lastConnected else { continue }
                lastConnected = connected
                if connected {
                    if self.hasConnectedOnce {
                        self.traceStore.resetAll()
                    } else {
                        try? await Task.sleep(nanoseconds: 100_000_000) // 100ms delay
                        guard !Task.isCancelled else { break }
                        self.windowState.restoreLastActivePanel()
                    }
                    self.hasConnectedOnce = true
                }
            }
        }
    }

    func handleDocumentEditorShow(_ msg: DocumentEditorShowMessage) {
        documentManager.createDocument(
            surfaceId: msg.surfaceId,
            conversationId: msg.conversationId,
            title: msg.title,
            initialContent: msg.initialContent
        )
        show()
        windowState.selection = .panel(.documentEditor)
    }

    func handleDocumentEditorUpdate(_ msg: DocumentEditorUpdateMessage) {
        documentManager.updateDocument(markdown: msg.markdown, mode: msg.mode)
    }

    func handleDocumentSaveResponse(_ msg: DocumentSaveResponseMessage) {
        documentManager.handleSaveResponse(success: msg.success, error: msg.error)
    }

    func handleDocumentLoadResponse(_ msg: DocumentLoadResponseMessage) {
        guard msg.success else {
            windowState.showToast(
                message: "Failed to load document\(msg.error.map { ": \($0)" } ?? "")",
                style: .error
            )
            return
        }
        documentManager.createDocument(
            surfaceId: msg.surfaceId,
            conversationId: msg.conversationId,
            title: msg.title,
            initialContent: msg.content
        )
        show()
        windowState.selection = .panel(.documentEditor)
    }

    func show() {
        // Switch to regular activation policy FIRST so macOS allows window
        // foregrounding — calling makeKeyAndOrderFront while still .accessory
        // can silently fail on Spotlight/Dock reopens.
        NSApp.activateAsDockAppIfNeeded()

        // Reuse the existing window if one already exists
        if let existing = window {
            if existing.isMiniaturized {
                existing.deminiaturize(nil)
            }
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        // Build a wake-up callback that sends the pending message once the
        // "coming alive" transition finishes. Capture the message eagerly so
        // the closure is self-contained.
        let wakeUpMessage = pendingWakeUpMessage
        let wakeUpCallback: (() -> Void)? = wakeUpMessage != nil ? { [weak self] in
            guard let self, let message = wakeUpMessage,
                  let viewModel = self.conversationManager.activeViewModel else { return }
            viewModel.inputText = message
            viewModel.sendMessage(hidden: true)
            self.pendingWakeUpMessage = nil
            // Only signal wake-up sent if the daemon is still connected.
            // If disconnected, sendMessage queued the message locally but
            // it may not reach the daemon — leave bootstrap at
            // pendingWakeupSend so the retry coordinator can intervene.
            if self.connectionManager.isConnected {
                self.onWakeUpSent?()
                self.onWakeUpSent = nil
            } else {
                self.onWakeUpSent = nil
            }
        } : nil

        let rootView = MainWindowView(conversationManager: conversationManager, appListManager: appListManager, zoomManager: zoomManager, traceStore: traceStore, usageDashboardStore: usageDashboardStore, connectionManager: connectionManager, eventStreamClient: eventStreamClient, surfaceManager: surfaceManager, ambientAgent: ambientAgent, settingsStore: services.settingsStore, authManager: services.authManager, windowState: windowState, assistantFeatureFlagStore: assistantFeatureFlagStore, documentManager: documentManager, onMicrophoneToggle: onMicrophoneToggle ?? {}, voiceModeManager: voiceModeManager, updateManager: updateManager, onSendWakeUp: wakeUpCallback)
        let hostingController = NonDraggableHostingController(rootView: rootView)

        let screenFrame = NSScreen.main?.visibleFrame ?? NSScreen.screens.first?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let windowWidth: CGFloat = 1200
        let windowHeight: CGFloat = 900
        let windowRect = NSRect(
            x: screenFrame.midX - windowWidth / 2,
            y: screenFrame.midY - windowHeight / 2,
            width: windowWidth,
            height: windowHeight
        )

        let window = TitleBarZoomableWindow(
            contentRect: windowRect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        window.contentViewController = hostingController
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = false
        window.backgroundColor = NSColor(VColor.surfaceBase)
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 800, height: 600)
        window.setFrame(windowRect, display: false)
        window.setFrameAutosaveName("MainWindow")
        window.delegate = closeDelegate

        window.observeAppActivation()

        window.makeKeyAndOrderFront(nil)

        configureTrafficLightPadding(window)
        NSApp.activate(ignoringOtherApps: true)

        self.window = window
    }

    // MARK: - Traffic Light Positioning

    private func configureTrafficLightPadding(_ window: NSWindow) {
        repositionTrafficLights(window)
        layoutObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResizeNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.repositionTrafficLights(window)
            }
        }
    }

    private func repositionTrafficLights(_ window: NSWindow) {
        guard let closeButton = window.standardWindowButton(.closeButton),
              let containerView = closeButton.superview else { return }
        if defaultTrafficLightOrigin == nil {
            defaultTrafficLightOrigin = containerView.frame.origin
        }
        guard let origin = defaultTrafficLightOrigin else { return }

        // Vertically center the traffic light buttons in the 48pt custom toolbar.
        // With fullSizeContentView, contentView.frame spans the entire window
        // interior (including under the titlebar), while contentLayoutRect covers
        // only the non-obscured portion. The difference gives the titlebar height.
        // This call runs after makeKeyAndOrderFront so contentView.frame is valid.
        guard let contentView = window.contentView else { return }
        let titlebarHeight = contentView.frame.height - window.contentLayoutRect.maxY
        let toolbarHeight: CGFloat = 48
        guard titlebarHeight > 0, titlebarHeight < toolbarHeight else { return }
        let verticalShift = (toolbarHeight - titlebarHeight) / 2

        containerView.setFrameOrigin(NSPoint(
            x: origin.x + 2,
            y: origin.y - verticalShift
        ))
    }

    /// Hide the window without destroying it (can be restored with `show()`).
    func hide() {
        window?.orderOut(nil)
    }

    func close() {
        if let observer = layoutObserver {
            NotificationCenter.default.removeObserver(observer)
            layoutObserver = nil
        }
        defaultTrafficLightOrigin = nil
        // Detach the SwiftUI hosting view before closing so that pending
        // view-graph updates cannot post constraint changes to a closed window,
        // which would crash in the AppKit display cycle.
        window?.contentViewController = nil
        window?.close()
        window = nil
    }

    /// Tears down internal observers and detaches the underlying NSWindow
    /// without closing it. The caller takes ownership of the returned window.
    func detachWindow() -> NSWindow? {
        if let observer = layoutObserver {
            NotificationCenter.default.removeObserver(observer)
            layoutObserver = nil
        }
        defaultTrafficLightOrigin = nil
        if let zoomable = window as? TitleBarZoomableWindow {
            zoomable.removeObservers()
            zoomable.composerRedirectHandler = nil
            zoomable.composerContainerView = nil
        }
        let detached = window
        window = nil
        return detached
    }
}
