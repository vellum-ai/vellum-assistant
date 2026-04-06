import AppKit
import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "ThreadWindow")

/// Standalone NSWindow that hosts a single conversation thread.
/// Used by `ThreadWindowManager` to pop a thread out of the main window
/// into its own detached window.
@MainActor
final class ThreadWindow: NSObject, NSWindowDelegate {
    let conversationLocalId: UUID
    private var window: NSWindow?
    private var layoutObserver: NSObjectProtocol?
    private var defaultTrafficLightOrigin: NSPoint?

    /// Fired when the user closes the window. The manager uses this
    /// to unpin the ViewModel and clean up tracking state.
    var onClose: (() -> Void)?

    init(conversationLocalId: UUID) {
        self.conversationLocalId = conversationLocalId
    }

    /// Build and show the pop-out window for the given conversation.
    func show(
        viewModel: ChatViewModel,
        conversationManager: ConversationManager,
        settingsStore: SettingsStore,
        ambientAgent: AmbientAgent,
        connectionManager: GatewayConnectionManager,
        eventStreamClient: EventStreamClient
    ) {
        if let existing = window {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let rootView = ThreadWindowContentView(
            viewModel: viewModel,
            conversationLocalId: conversationLocalId,
            conversationManager: conversationManager,
            settingsStore: settingsStore,
            ambientAgent: ambientAgent,
            onFork: { [weak conversationManager] daemonMessageId in
                guard let conversationManager else { return }
                Task { @MainActor in
                    await conversationManager.forkConversation(throughDaemonMessageId: daemonMessageId)
                }
            }
        )

        let hostingController = NSHostingController(rootView: rootView)

        let screenFrame = NSScreen.main?.visibleFrame
            ?? NSScreen.screens.first?.visibleFrame
            ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let windowWidth: CGFloat = 700
        let windowHeight: CGFloat = 700
        let windowRect = NSRect(
            x: screenFrame.midX - windowWidth / 2 + CGFloat.random(in: -40...40),
            y: screenFrame.midY - windowHeight / 2 + CGFloat.random(in: -40...40),
            width: windowWidth,
            height: windowHeight
        )

        let title = conversationManager.conversations.first(where: { $0.id == conversationLocalId })?.title ?? "Thread"

        let nsWindow = TitleBarZoomableWindow(
            contentRect: windowRect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )

        nsWindow.contentViewController = hostingController
        nsWindow.titleVisibility = .hidden
        nsWindow.titlebarAppearsTransparent = true
        nsWindow.isMovableByWindowBackground = false
        nsWindow.backgroundColor = NSColor(VColor.surfaceBase)
        nsWindow.isReleasedWhenClosed = false
        nsWindow.contentMinSize = NSSize(width: 480, height: 400)
        nsWindow.setFrame(windowRect, display: false)
        nsWindow.title = title
        nsWindow.delegate = self

        nsWindow.makeKeyAndOrderFront(nil)
        configureTrafficLightPadding(nsWindow)
        NSApp.activate(ignoringOtherApps: true)

        self.window = nsWindow
        log.info("Opened thread window for conversation \(self.conversationLocalId)")
    }

    func updateTitle(_ title: String) {
        window?.title = title
    }

    func close() {
        teardown()
        // Detach the SwiftUI hosting view before closing so that pending
        // view-graph updates cannot post constraint changes to a closed window,
        // which would crash in the AppKit display cycle.
        window?.contentViewController = nil
        window?.close()
        window = nil
    }

    private func teardown() {
        if let observer = layoutObserver {
            NotificationCenter.default.removeObserver(observer)
            layoutObserver = nil
        }
        defaultTrafficLightOrigin = nil
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
        guard let origin = defaultTrafficLightOrigin,
              let contentView = window.contentView else { return }
        let titlebarHeight = contentView.frame.height - window.contentLayoutRect.maxY
        let toolbarHeight: CGFloat = 48
        guard titlebarHeight > 0, titlebarHeight < toolbarHeight else { return }
        let verticalShift = (toolbarHeight - titlebarHeight) / 2
        containerView.setFrameOrigin(NSPoint(
            x: origin.x + 2,
            y: origin.y - verticalShift
        ))
    }

    // MARK: - NSWindowDelegate

    nonisolated func windowWillClose(_ notification: Notification) {
        MainActor.assumeIsolated {
            log.info("Thread window closed for conversation \(self.conversationLocalId)")
            teardown()
            // Detach SwiftUI hosting view to prevent layout crashes on close.
            window?.contentViewController = nil
            window = nil
            onClose?()
        }
    }
}

// MARK: - Thread Window Content View

/// SwiftUI root view for a pop-out thread window.
/// Renders a simplified chat view with a title bar and the conversation content.
/// Avoids observing `ConversationManager` directly — only the specific callbacks
/// and data needed are passed in to prevent broad re-renders.
private struct ThreadWindowContentView: View {
    @Bindable var viewModel: ChatViewModel
    let conversationLocalId: UUID
    var conversationManager: ConversationManager
    @ObservedObject var settingsStore: SettingsStore
    var ambientAgent: AmbientAgent
    let onFork: (String) -> Void

    @State private var anchorMessageId: UUID?
    @State private var highlightedMessageId: UUID?

    /// Derived title from ConversationManager — updates reactively when
    /// the conversation is renamed, avoiding the stale-title bug.
    private var title: String {
        conversationManager.conversations.first(where: { $0.id == conversationLocalId })?.title ?? "Thread"
    }

    @State private var showTitleActions = false

    var body: some View {
        ZStack(alignment: .top) {
            VStack(spacing: 0) {
                threadTitleBar
                ChatView(
                    viewModel: viewModel,
                    selectedModel: settingsStore.selectedModel,
                    configuredProviders: settingsStore.configuredProviders,
                    providerCatalog: settingsStore.providerCatalog,
                    mediaEmbedSettings: MediaEmbedResolverSettings(
                        enabled: settingsStore.mediaEmbedsEnabled,
                        enabledSince: settingsStore.mediaEmbedsEnabledSince,
                        allowedDomains: settingsStore.mediaEmbedVideoAllowlistDomains
                    ),
                    onMicrophoneToggle: {},
                    onForkFromMessage: (conversation?.isChannelConversation ?? false) ? nil : { daemonMessageId in onFork(daemonMessageId) },
                    onAddFunds: {
                        settingsStore.pendingSettingsTab = .billing
                        AppDelegate.shared?.showSettingsWindow(nil)
                    },
                    onOpenModelsAndServices: {
                        settingsStore.pendingSettingsTab = .modelsAndServices
                        AppDelegate.shared?.showSettingsWindow(nil)
                    },
                    recoveryMode: settingsStore.managedAssistantRecoveryMode,
                    isRecoveryModeExiting: settingsStore.recoveryModeExiting,
                    onResumeAssistant: {
                        settingsStore.exitManagedAssistantRecoveryMode()
                    },
                    onOpenSSHSettings: {
                        settingsStore.pendingSettingsTab = .developer
                        AppDelegate.shared?.showSettingsWindow(nil)
                    },
                    anchorMessageId: $anchorMessageId,
                    highlightedMessageId: $highlightedMessageId,
                    isInteractionEnabled: true,
                    isReadonly: conversation?.isChannelConversation ?? false,
                    watchSession: ambientAgent.activeWatchSession
                )
                .environment(\.cmdEnterToSend, settingsStore.cmdEnterToSend)
                .padding(.bottom, VSpacing.md)
            }

            // Actions drawer rendered above all content
            if showTitleActions {
                // Dismiss backdrop
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { withAnimation { showTitleActions = false } }

                threadTitleActionsDrawer
                    .offset(y: 48)
            }
        }
        .frame(minWidth: 480, maxWidth: .infinity, minHeight: 400, maxHeight: .infinity)
        .background(VColor.surfaceBase)
    }

    private var threadTitleBar: some View {
        HStack {
            // Left padding to avoid traffic light buttons
            Spacer().frame(width: 72)
            Spacer()
            VButton(
                label: title,
                rightIcon: VIcon.chevronDown.rawValue,
                style: .ghost
            ) {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.7)) {
                    showTitleActions.toggle()
                }
            }
            .lineLimit(1)
            Spacer()
            // Right padding to balance
            Spacer().frame(width: 72)
        }
        .frame(height: 48)
        .background(VColor.surfaceBase)
    }

    private var conversation: ConversationModel? {
        conversationManager.conversations.first(where: { $0.id == conversationLocalId })
    }

    private var threadTitleActionsDrawer: some View {
        VStack(alignment: .leading, spacing: 0) {
            SidebarPrimaryRow(
                icon: (conversation?.isPinned ?? false) ? VIcon.pinOff.rawValue : VIcon.pin.rawValue,
                label: (conversation?.isPinned ?? false) ? "Unpin" : "Pin",
                action: {
                    if conversation?.isPinned ?? false {
                        conversationManager.unpinConversation(id: conversationLocalId)
                    } else {
                        conversationManager.pinConversation(id: conversationLocalId)
                    }
                    showTitleActions = false
                }
            )
            if !(conversation?.isChannelConversation ?? false) {
                SidebarPrimaryRow(icon: VIcon.archive.rawValue, label: "Archive", action: {
                    conversationManager.archiveConversation(id: conversationLocalId)
                    showTitleActions = false
                })
            }
        }
        .padding(VSpacing.sm)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 1.5, x: 0, y: 1)
        .shadow(color: VColor.auxBlack.opacity(0.1), radius: 6, x: 0, y: 4)
        .frame(width: 200)
        .transition(.opacity.combined(with: .scale(scale: 0.95, anchor: .top)))
    }
}
