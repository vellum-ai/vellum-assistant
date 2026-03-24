import AppKit
import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ThreadWindow")

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
        title: String,
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
            title: title,
            conversationManager: conversationManager,
            settingsStore: settingsStore,
            ambientAgent: ambientAgent,
            connectionManager: connectionManager
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
            window = nil
            onClose?()
        }
    }
}

// MARK: - Thread Window Content View

/// SwiftUI root view for a pop-out thread window.
/// Renders a simplified chat view with a title bar and the conversation content.
private struct ThreadWindowContentView: View {
    @ObservedObject var viewModel: ChatViewModel
    let title: String
    @ObservedObject var conversationManager: ConversationManager
    @ObservedObject var settingsStore: SettingsStore
    @ObservedObject var ambientAgent: AmbientAgent
    let connectionManager: GatewayConnectionManager

    @State private var anchorMessageId: UUID?
    @State private var highlightedMessageId: UUID?

    var body: some View {
        VStack(spacing: 0) {
            threadTitleBar
            chatContent
        }
        .background(VColor.surfaceBase)
    }

    private var threadTitleBar: some View {
        HStack {
            // Left padding to avoid traffic light buttons
            Spacer().frame(width: 72)
            Spacer()
            Text(title)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)
            Spacer()
            // Right padding to balance
            Spacer().frame(width: 72)
        }
        .frame(height: 48)
        .background(VColor.surfaceBase)
    }

    private var chatContent: some View {
        ChatView(
            messages: viewModel.messages,
            inputText: Binding(
                get: { viewModel.inputText },
                set: { viewModel.inputText = $0 }
            ),
            isThinking: viewModel.isThinking,
            isCompacting: viewModel.isCompacting,
            isSending: viewModel.isSending,
            suggestion: viewModel.suggestion,
            pendingAttachments: viewModel.pendingAttachments,
            isLoadingAttachment: viewModel.isLoadingAttachment,
            isRecording: viewModel.isRecording,
            onSend: { viewModel.sendMessage() },
            onStop: viewModel.stopGenerating,
            onAcceptSuggestion: viewModel.acceptSuggestion,
            onAttach: {},
            onRemoveAttachment: { viewModel.removeAttachment(id: $0) },
            onDropFiles: { urls in urls.forEach { viewModel.addAttachment(url: $0) } },
            onDropImageData: { data, name in
                let filename: String
                if let name {
                    let basename = (name as NSString).lastPathComponent
                    let base = (basename as NSString).deletingPathExtension
                    filename = base.isEmpty ? "Dropped Image.png" : "\(base).png"
                } else {
                    filename = "Dropped Image.png"
                }
                viewModel.addAttachment(imageData: data, filename: filename)
            },
            onPaste: { viewModel.addAttachmentFromPasteboard() },
            onMicrophoneToggle: {},
            selectedModel: settingsStore.selectedModel,
            configuredProviders: settingsStore.configuredProviders,
            providerCatalog: settingsStore.providerCatalog,
            assistantActivityPhase: viewModel.assistantActivityPhase,
            assistantActivityAnchor: viewModel.assistantActivityAnchor,
            assistantActivityReason: viewModel.assistantActivityReason,
            assistantStatusText: viewModel.assistantStatusText,
            onConfirmationAllow: { requestId in viewModel.respondToConfirmation(requestId: requestId, decision: "allow") },
            onConfirmationDeny: { requestId in viewModel.respondToConfirmation(requestId: requestId, decision: "deny") },
            onAlwaysAllow: { requestId, selectedPattern, selectedScope, decision in viewModel.respondToAlwaysAllow(requestId: requestId, selectedPattern: selectedPattern, selectedScope: selectedScope, decision: decision) },
            onTemporaryAllow: { requestId, decision in viewModel.respondToConfirmation(requestId: requestId, decision: decision) },
            onGuardianAction: { requestId, action in viewModel.submitGuardianDecision(requestId: requestId, action: action) },
            onSurfaceAction: { surfaceId, actionId, data in viewModel.sendSurfaceAction(surfaceId: surfaceId, actionId: actionId, data: data) },
            watchSession: ambientAgent.activeWatchSession,
            onStopWatch: { viewModel.stopWatchSession() },
            onForkFromMessage: { [conversationManager] daemonMessageId in
                Task { @MainActor in
                    await conversationManager.forkConversation(throughDaemonMessageId: daemonMessageId)
                }
            },
            onRetryFailedMessage: { messageId in
                viewModel.retryFailedMessage(id: messageId)
            },
            onRetryConversationError: { messageId in
                viewModel.retryAfterConversationError(messageId: messageId)
            },
            subagentDetailStore: viewModel.subagentDetailStore,
            isHistoryLoaded: viewModel.isHistoryLoaded,
            anchorMessageId: $anchorMessageId,
            highlightedMessageId: $highlightedMessageId,
            creditsExhaustedError: viewModel.errorManager.conversationError?.isCreditsExhausted == true ? viewModel.errorManager.conversationError : nil,
            onAddFunds: {
                settingsStore.pendingSettingsTab = .billing
            },
            onDismissCreditsExhausted: { viewModel.dismissConversationError() },
            providerNotConfiguredError: viewModel.errorManager.conversationError?.isProviderNotConfigured == true ? viewModel.errorManager.conversationError : nil,
            onOpenModelsAndServices: {
                settingsStore.pendingSettingsTab = .modelsAndServices
            },
            onDismissProviderNotConfigured: { viewModel.dismissConversationError() },
            displayedMessageCount: viewModel.displayedMessageCount,
            hasMoreMessages: viewModel.hasMoreMessages,
            isLoadingMoreMessages: viewModel.isLoadingMoreMessages,
            loadPreviousMessagePage: { await viewModel.loadPreviousMessagePage() }
        )
    }
}
