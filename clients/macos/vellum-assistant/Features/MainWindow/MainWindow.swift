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
    var onMicrophoneToggle: (() -> Void)?

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
        self.threadManager = ThreadManager(daemonClient: services.daemonClient)
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

        let hostingController = NSHostingController(rootView: MainWindowView(threadManager: threadManager, zoomManager: zoomManager, traceStore: traceStore, daemonClient: daemonClient, surfaceManager: surfaceManager, ambientAgent: ambientAgent, onMicrophoneToggle: onMicrophoneToggle ?? {}))

        let screenFrame = NSScreen.main?.visibleFrame ?? NSScreen.screens.first?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)

        let window = NSWindow(
            contentRect: screenFrame,
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
        window.setFrame(screenFrame, display: false)

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
        if let observer = layoutObserver {
            NotificationCenter.default.removeObserver(observer)
            layoutObserver = nil
        }
        defaultTrafficLightOrigin = nil
        window?.close()
        window = nil
    }
}
