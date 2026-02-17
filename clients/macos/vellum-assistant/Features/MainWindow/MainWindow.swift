import AppKit
import Combine
import VellumAssistantShared
import SwiftUI

@MainActor
final class MainWindow {
    private let services: AppServices
    private var window: NSWindow?
    let threadManager: ThreadManager
    let traceStore = TraceStore()
    let windowState = MainWindowState()
    var onMicrophoneToggle: (() -> Void)?

    /// The pop-out chat window, created on demand when the user pops out chat.
    private var chatWindow: ChatWindow?

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

    init(services: AppServices) {
        self.services = services
        self.threadManager = ThreadManager(
            daemonClient: services.daemonClient,
            activityNotificationService: services.activityNotificationService
        )
        self.threadManager.ambientAgent = services.ambientAgent
        services.daemonClient.onTraceEvent = { [weak self] msg in
            Task { @MainActor in
                self?.traceStore.ingest(msg)
            }
        }
        services.daemonClient.onDashboardThemeUpdate = { [weak self] msg in
            Task { @MainActor in
                self?.handleDashboardThemeUpdate(msg)
            }
        }
        services.daemonClient.onDashboardTaskKickoff = { [weak self] msg in
            Task { @MainActor in
                self?.handleDashboardTaskKickoff(msg)
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
                    }
                    self.hasConnectedOnce = true
                }
            }
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

        let hostingController = NSHostingController(rootView: MainWindowView(threadManager: threadManager, zoomManager: zoomManager, traceStore: traceStore, daemonClient: daemonClient, surfaceManager: surfaceManager, ambientAgent: ambientAgent, settingsStore: services.settingsStore, windowState: windowState, onMicrophoneToggle: onMicrophoneToggle ?? {}, onPopOutChat: { [weak self] in self?.popOutChat() }, onDockChat: { [weak self] in self?.dockChat() }))

        let screenFrame = NSScreen.main?.visibleFrame ?? NSScreen.screens.first?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let windowWidth = min(screenFrame.width * 0.8, 1200)
        let windowHeight = min(screenFrame.height * 0.85, 900)
        let windowRect = NSRect(
            x: screenFrame.midX - windowWidth / 2,
            y: screenFrame.midY - windowHeight / 2,
            width: windowWidth,
            height: windowHeight
        )

        let window = NSWindow(
            contentRect: windowRect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        window.contentViewController = hostingController
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
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
            Task { @MainActor in
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
        containerView.setFrameOrigin(NSPoint(
            x: origin.x + 2,
            y: origin.y - 2.5
        ))
    }

    func close() {
        chatWindow?.close()
        chatWindow = nil
        windowState.isChatPoppedOut = false
        if let observer = layoutObserver {
            NotificationCenter.default.removeObserver(observer)
            layoutObserver = nil
        }
        defaultTrafficLightOrigin = nil
        window?.close()
        window = nil
    }

    // MARK: - Pop-out / Dock Chat

    /// Open the chat in a separate window, switching the main window to
    /// dashboard mode.
    private func popOutChat() {
        guard chatWindow == nil else {
            chatWindow?.show()
            return
        }

        let chatWin = ChatWindow(
            threadManager: threadManager,
            windowState: windowState,
            ambientAgent: ambientAgent,
            onMicrophoneToggle: onMicrophoneToggle ?? {},
            onClose: { [weak self] in
                self?.windowState.isChatPoppedOut = false
                self?.windowState.contentMode = .chat
                self?.chatWindow = nil
            }
        )
        chatWin.show()
        chatWindow = chatWin
        windowState.isChatPoppedOut = true
        windowState.contentMode = .dashboard
    }

    /// Close the pop-out chat window and dock it back into the main window.
    private func dockChat() {
        chatWindow?.close()
        chatWindow = nil
        windowState.isChatPoppedOut = false
        windowState.contentMode = .chat
    }

    // MARK: - Dashboard Message Handlers

    /// Apply a theme/color update from the daemon to the dashboard.
    /// Writes directly to `UserDefaults` so the values persist even when
    /// `DashboardView` is not mounted (e.g. user is in chat mode during
    /// the "Make it yours" flow). The `@AppStorage` properties in
    /// `DashboardView` will pick up the new values automatically when
    /// the view is next mounted. The notification is still posted for any
    /// live observers.
    private func handleDashboardThemeUpdate(_ msg: DashboardThemeUpdateMessage) {
        UserDefaults.standard.set(msg.colorHex, forKey: "dashboardAccentColorHex")
        UserDefaults.standard.set(msg.colorName, forKey: "dashboardAccentColorName")
        NotificationCenter.default.post(
            name: .dashboardThemeDidUpdate,
            object: nil,
            userInfo: [
                "colorHex": msg.colorHex,
                "colorName": msg.colorName,
            ]
        )
    }

    /// Handle a task kickoff directive from the daemon. Creates a new thread,
    /// switches to chat mode, and sends the kickoff message.
    private func handleDashboardTaskKickoff(_ msg: DashboardTaskKickoffMessage) {
        threadManager.createThread()
        windowState.contentMode = .chat
        if let viewModel = threadManager.activeViewModel {
            viewModel.inputText = "[STARTER_TASK:\(msg.taskId)]"
            viewModel.sendMessage()
        }
    }
}
