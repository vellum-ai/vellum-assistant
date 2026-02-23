import AppKit
import Combine
import VellumAssistantShared
import SwiftUI

/// NSWindow subclass that restores double-click-to-zoom on the title bar.
/// With `fullSizeContentView` + `titlebarAppearsTransparent`, the system
/// title bar becomes invisible and stops handling double-clicks. This
/// subclass detects double-clicks in the title bar zone and performs the
/// action configured in System Settings (zoom or minimize).
///
/// We manually track the pre-zoom frame because `NSWindow.isZoomed` can be
/// unreliable with `fullSizeContentView`, causing `zoom(nil)` not to toggle
/// back to the previous size.
class TitleBarZoomableWindow: NSWindow {
    private var preZoomFrame: NSRect?

    /// Weak reference to the composer text view so we can redirect typing to it.
    weak var composerTextView: NSTextView?

    override func keyDown(with event: NSEvent) {
        // If a text view is already focused, let it handle the event normally.
        if firstResponder is NSTextView {
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

        // Redirect to the composer text view.
        if let composer = composerTextView {
            makeFirstResponder(composer)
            composer.keyDown(with: event)
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
private class NonDraggableContainerView: NSView {
    override var mouseDownCanMoveWindow: Bool { false }
}

@MainActor
final class MainWindow {
    private let services: AppServices
    private var window: NSWindow?
    let threadManager: ThreadManager
    let appListManager = AppListManager()
    let traceStore = TraceStore()
    let windowState = MainWindowState()
    let documentManager = DocumentManager()
    let avatarEvolutionState: AvatarEvolutionState?
    var onMicrophoneToggle: (() -> Void)?
    let voiceModeManager = VoiceModeManager()

    /// Wake-up greeting to auto-send after the "coming alive" transition completes.
    /// Set by AppDelegate on first launch; consumed by MainWindowView.
    var pendingWakeUpMessage: String?

    // Forwarding accessors — keeps existing references working while
    // ownership lives in the `services` container.
    private var daemonClient: DaemonClient { services.daemonClient }
    private var surfaceManager: SurfaceManager { services.surfaceManager }
    private var ambientAgent: AmbientAgent { services.ambientAgent }
    private var zoomManager: ZoomManager { services.zoomManager }

    /// Tracks daemon reconnects so trace state can be reset on stream restart.
    private var connectionCancellable: AnyCancellable?
    private var layoutObserver: NSObjectProtocol?
    private var defaultTrafficLightOrigin: NSPoint?
    private var hasConnectedOnce = false

    /// Whether the main window is currently visible on screen.
    var isVisible: Bool {
        window?.isVisible ?? false
    }

    /// The active ChatViewModel from the current thread, if any.
    var activeViewModel: ChatViewModel? {
        threadManager.activeViewModel
    }

    init(services: AppServices, isFirstLaunch: Bool = false) {
        self.services = services
        self.threadManager = ThreadManager(
            daemonClient: services.daemonClient,
            activityNotificationService: services.activityNotificationService,
            isFirstLaunch: isFirstLaunch
        )
        if isFirstLaunch {
            let evoState = AvatarEvolutionState()
            evoState.load()
            self.avatarEvolutionState = evoState
        } else {
            self.avatarEvolutionState = nil
        }
        self.threadManager.ambientAgent = services.ambientAgent
        documentManager.daemonClient = daemonClient
        services.daemonClient.onTraceEvent = { [weak self] msg in
            Task { @MainActor in
                self?.traceStore.ingest(msg)
            }
        }
        observeDaemonReconnects()
    }

    /// Reset trace state when the daemon reconnects after a disconnect.
    /// The trace event stream is ephemeral; a reconnect means the daemon
    /// restarted and any in-flight trace context is stale.
    private func observeDaemonReconnects() {
        connectionCancellable = daemonClient.$isConnected
            .removeDuplicates()
            .sink { [weak self] connected in
                guard let self else { return }
                if connected {
                    if self.hasConnectedOnce {
                        self.traceStore.resetAll()
                    } else {
                        // First connect: restore panel after thread restoration
                        Task { @MainActor in
                            try? await Task.sleep(nanoseconds: 100_000_000) // 100ms delay
                            self.windowState.restoreLastActivePanel()
                        }
                    }
                    self.hasConnectedOnce = true
                }
            }
    }

    func handleDocumentEditorShow(_ msg: DocumentEditorShowMessage) {
        documentManager.createDocument(
            surfaceId: msg.surfaceId,
            sessionId: msg.sessionId,
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
            sessionId: msg.conversationId,
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
        NSApp.setActivationPolicy(.regular)

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
                  let viewModel = self.threadManager.activeViewModel else { return }
            viewModel.inputText = message
            viewModel.sendMessage()
            self.pendingWakeUpMessage = nil
        } : nil

        let rootView = MainWindowView(threadManager: threadManager, appListManager: appListManager, zoomManager: zoomManager, traceStore: traceStore, daemonClient: daemonClient, surfaceManager: surfaceManager, ambientAgent: ambientAgent, settingsStore: services.settingsStore, windowState: windowState, documentManager: documentManager, avatarEvolutionState: avatarEvolutionState, onMicrophoneToggle: onMicrophoneToggle ?? {}, voiceModeManager: voiceModeManager, onSendWakeUp: wakeUpCallback)
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
        window.backgroundColor = NSColor(VColor.background)
        window.isReleasedWhenClosed = false
        window.contentMinSize = NSSize(width: 800, height: 600)
        window.setFrame(windowRect, display: false)
        window.setFrameAutosaveName("MainWindow")

        configureTrafficLightPadding(window)

        window.makeKeyAndOrderFront(nil)
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
            guard let strongSelf = self else { return }
            Task { @MainActor in
                strongSelf.repositionTrafficLights(window)
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
        containerView.setFrameOrigin(NSPoint(
            x: origin.x + 2,
            y: origin.y - 2.5
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
        window?.close()
        window = nil
    }
}
