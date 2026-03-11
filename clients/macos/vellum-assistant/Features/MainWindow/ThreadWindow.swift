import AppKit
import Combine
import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ThreadWindow")

/// A lightweight window that displays a single thread's chat.
/// Used when a user pops a thread out into its own window.
@MainActor
final class ThreadWindow: NSObject, NSWindowDelegate {
    let threadId: UUID
    private var window: NSWindow?
    private let onClose: () -> Void

    init(
        threadId: UUID,
        title: String,
        viewModel: ChatViewModel,
        daemonClient: DaemonClient,
        settingsStore: SettingsStore,
        onClose: @escaping () -> Void
    ) {
        self.threadId = threadId
        self.onClose = onClose
        super.init()

        let rootView = ThreadWindowContentView(
            viewModel: viewModel,
            daemonClient: daemonClient,
            settingsStore: settingsStore,
            title: title
        )
        let hostingController = NSHostingController(rootView: rootView)

        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let windowWidth: CGFloat = 900
        let windowHeight: CGFloat = 700
        // Offset slightly from center so it doesn't overlap the main window exactly
        let windowRect = NSRect(
            x: screenFrame.midX - windowWidth / 2 + 40,
            y: screenFrame.midY - windowHeight / 2 - 20,
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
        nsWindow.title = title
        nsWindow.titleVisibility = .hidden
        nsWindow.titlebarAppearsTransparent = true
        nsWindow.isMovableByWindowBackground = false
        nsWindow.backgroundColor = NSColor(VColor.backgroundSubtle)
        nsWindow.isReleasedWhenClosed = false
        nsWindow.contentMinSize = NSSize(width: 500, height: 400)
        nsWindow.setFrame(windowRect, display: false)
        nsWindow.setFrameAutosaveName("ThreadWindow-\(threadId.uuidString)")
        nsWindow.delegate = self
        nsWindow.observeAppActivation()

        self.window = nsWindow
    }

    func show() {
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func focus() {
        if let window, window.isMiniaturized {
            window.deminiaturize(nil)
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func updateTitle(_ title: String) {
        window?.title = title
    }

    func close() {
        window?.close()
    }

    // MARK: - NSWindowDelegate

    nonisolated func windowWillClose(_ notification: Notification) {
        MainActor.assumeIsolated {
            onClose()
        }
    }
}

// MARK: - SwiftUI Content View

/// The root SwiftUI view for a detached thread window.
/// Contains a title bar area and the chat view.
struct ThreadWindowContentView: View {
    @ObservedObject var viewModel: ChatViewModel
    let daemonClient: DaemonClient
    @ObservedObject var settingsStore: SettingsStore
    let title: String

    @AppStorage("themePreference") private var themePreference: String = "system"
    @State private var systemIsDark: Bool = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua

    var body: some View {
        VStack(spacing: 0) {
            // Title bar
            HStack {
                Spacer()
                Text(title)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(1)
                Spacer()
            }
            .frame(height: 36)
            .padding(.horizontal, 78) // Account for traffic lights
            .background(VColor.backgroundSubtle)

            // Chat content
            DetachedChatViewWrapper(
                viewModel: viewModel,
                daemonClient: daemonClient,
                settingsStore: settingsStore
            )
            .padding(16)
        }
        .ignoresSafeArea(edges: .top)
        .background(VColor.background.ignoresSafeArea())
        .preferredColorScheme(themePreference == "light" ? .light : themePreference == "dark" ? .dark : systemIsDark ? .dark : .light)
        .onReceive(DistributedNotificationCenter.default().publisher(for: Notification.Name("AppleInterfaceThemeChangedNotification"))) { _ in
            systemIsDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        }
    }
}

/// Simplified chat wrapper for detached thread windows.
/// Mirrors ActiveChatViewWrapper but without voice mode, ambient agent, etc.
struct DetachedChatViewWrapper: View {
    @ObservedObject var viewModel: ChatViewModel
    let daemonClient: DaemonClient
    @ObservedObject var settingsStore: SettingsStore
    @State private var anchorMessageId: UUID?

    var body: some View {
        ChatView(
            messages: viewModel.messages,
            inputText: Binding(
                get: { viewModel.inputText },
                set: { viewModel.inputText = $0 }
            ),
            hasAPIKey: true,
            isThinking: viewModel.isThinking,
            isSending: viewModel.isSending,
            errorText: viewModel.errorText,
            pendingQueuedCount: viewModel.pendingQueuedCount,
            suggestion: viewModel.suggestion,
            pendingAttachments: viewModel.pendingAttachments,
            isLoadingAttachment: viewModel.isLoadingAttachment,
            isRecording: viewModel.isRecording,
            onOpenSettings: {},
            onSend: { viewModel.sendMessage() },
            onStop: viewModel.stopGenerating,
            onDismissError: viewModel.dismissError,
            isRetryableError: viewModel.isRetryableError,
            onRetryError: { viewModel.retryLastMessage() },
            isConnectionError: viewModel.isConnectionError,
            hasRetryPayload: viewModel.hasRetryPayload,
            isSecretBlockError: viewModel.isSecretBlockError,
            onSendAnyway: { viewModel.sendAnyway() },
            onAcceptSuggestion: viewModel.acceptSuggestion,
            onAttach: { openFilePicker(viewModel: viewModel) },
            onRemoveAttachment: { viewModel.removeAttachment(id: $0) },
            onDropFiles: { urls in urls.forEach { viewModel.addAttachment(url: $0) } },
            onDropImageData: { data, name in
                let filename: String
                if let name {
                    let base = ((name as NSString).lastPathComponent as NSString).deletingPathExtension
                    filename = base.isEmpty ? "Dropped Image.png" : "\(base).png"
                } else {
                    filename = "Dropped Image.png"
                }
                viewModel.addAttachment(imageData: data, filename: filename)
            },
            onPaste: { viewModel.addAttachmentFromPasteboard() },
            onMicrophoneToggle: {},
            onModelPickerSelect: { _, modelId in settingsStore.setModel(modelId) },
            selectedModel: settingsStore.selectedModel,
            configuredProviders: settingsStore.configuredProviders,
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
            sessionError: viewModel.sessionError,
            onRetry: { viewModel.retryAfterSessionError() },
            onDismissSessionError: { viewModel.dismissSessionError() },
            onCopyDebugInfo: { viewModel.copySessionErrorDebugDetails() },
            watchSession: nil,
            onStopWatch: {},
            onReportMessage: { daemonMessageId in
                guard let sessionId = viewModel.sessionId else { return }
                do {
                    try daemonClient.sendDiagnosticsExportRequest(
                        conversationId: sessionId,
                        anchorMessageId: daemonMessageId
                    )
                } catch {}
            },
            mediaEmbedSettings: MediaEmbedResolverSettings(
                enabled: settingsStore.mediaEmbedsEnabled,
                enabledSince: settingsStore.mediaEmbedsEnabledSince,
                allowedDomains: settingsStore.mediaEmbedVideoAllowlistDomains
            ),
            activeSubagents: viewModel.activeSubagents,
            onAbortSubagent: { subagentId in
                try? daemonClient.sendSubagentAbort(subagentId: subagentId)
            },
            onRehydrateMessage: { messageId in
                viewModel.rehydrateMessage(id: messageId)
            },
            onSurfaceRefetch: { surfaceId, sessionId in
                viewModel.refetchStrippedSurface(surfaceId: surfaceId, sessionId: sessionId)
            },
            subagentDetailStore: viewModel.subagentDetailStore,
            resolveHttpPort: daemonClient.httpPortResolver,
            isHistoryLoaded: viewModel.isHistoryLoaded,
            dismissedDocumentSurfaceIds: viewModel.dismissedDocumentSurfaceIds,
            onDismissDocumentWidget: { viewModel.dismissDocumentSurface(id: $0) },
            connectionDiagnosticHint: viewModel.connectionDiagnosticHint,
            anchorMessageId: $anchorMessageId,
            displayedMessageCount: viewModel.displayedMessageCount,
            hasMoreMessages: viewModel.hasMoreMessages,
            isLoadingMoreMessages: viewModel.isLoadingMoreMessages,
            loadPreviousMessagePage: { await viewModel.loadPreviousMessagePage() }
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .environment(\.cmdEnterToSend, settingsStore.cmdEnterToSend)
    }
}
