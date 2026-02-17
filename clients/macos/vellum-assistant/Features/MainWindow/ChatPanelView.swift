import SwiftUI
import VellumAssistantShared
import UniformTypeIdentifiers

/// Reusable chat panel that wraps the existing ChatView for use in both
/// docked (inside the main window) and pop-out (separate ChatWindow) modes.
/// It binds to a ThreadManager and MainWindowState so that message/session
/// state is shared regardless of where the panel is displayed.
struct ChatPanelView: View {
    @ObservedObject var threadManager: ThreadManager
    @ObservedObject var windowState: MainWindowState
    let ambientAgent: AmbientAgent
    let onMicrophoneToggle: () -> Void

    var body: some View {
        Group {
            if let viewModel = threadManager.activeViewModel {
                ChatView(
                    messages: viewModel.messages,
                    inputText: Binding(
                        get: { viewModel.inputText },
                        set: { viewModel.inputText = $0 }
                    ),
                    hasAPIKey: windowState.hasAPIKey,
                    isThinking: viewModel.isThinking,
                    isSending: viewModel.isSending,
                    errorText: viewModel.errorText,
                    pendingQueuedCount: viewModel.pendingQueuedCount,
                    suggestion: viewModel.suggestion,
                    pendingAttachments: viewModel.pendingAttachments,
                    isRecording: viewModel.isRecording,
                    onOpenSettings: {
                        windowState.activePanel = .settings
                        if windowState.isChatPoppedOut {
                            // When chat is popped out, the main window is in
                            // dashboard mode which doesn't render side panels.
                            // Switch to chat mode so the settings panel is
                            // visible, and bring the main window forward.
                            windowState.contentMode = .chat
                            Self.bringMainWindowToFront()
                        }
                    },
                    onSend: viewModel.sendMessage,
                    onStop: viewModel.stopGenerating,
                    onDismissError: viewModel.dismissError,
                    onAcceptSuggestion: viewModel.acceptSuggestion,
                    onAttach: { Self.openFilePicker(viewModel: viewModel) },
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
                    onMicrophoneToggle: onMicrophoneToggle,
                    onConfirmationAllow: { requestId in viewModel.respondToConfirmation(requestId: requestId, decision: "allow") },
                    onConfirmationDeny: { requestId in viewModel.respondToConfirmation(requestId: requestId, decision: "deny") },
                    onAddTrustRule: { toolName, pattern, scope, decision in return viewModel.addTrustRule(toolName: toolName, pattern: pattern, scope: scope, decision: decision) },
                    onSurfaceAction: { surfaceId, actionId, data in viewModel.sendSurfaceAction(surfaceId: surfaceId, actionId: actionId, data: data) },
                    onRegenerate: { viewModel.regenerateLastMessage() },
                    sessionError: viewModel.sessionError,
                    onRetry: { viewModel.retryAfterSessionError() },
                    onDismissSessionError: { viewModel.dismissSessionError() },
                    onCopyDebugInfo: { viewModel.copySessionErrorDebugDetails() },
                    watchSession: ambientAgent.activeWatchSession,
                    onStopWatch: { viewModel.stopWatchSession() },
                    onOpenActivity: { toolCalls in
                        windowState.toggleActivityPanel(with: toolCalls)
                    },
                    isActivityPanelOpen: windowState.activePanel == .activity
                )
            } else {
                VStack {
                    Spacer()
                    Text("No active conversation")
                        .font(VFont.body)
                        .foregroundColor(VColor.textMuted)
                    Spacer()
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(VColor.chatBackground)
            }
        }
    }

    /// Bring the main window to the front so the user can see the settings
    /// panel that was just opened. Used when opening settings from pop-out mode.
    @MainActor
    private static func bringMainWindowToFront() {
        for window in NSApp.windows where window.frameAutosaveName == "MainWindow" {
            window.makeKeyAndOrderFront(nil)
            break
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    @MainActor
    private static func openFilePicker(viewModel: ChatViewModel) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [
            .png, .jpeg, .gif, .webP, .pdf, .plainText, .commaSeparatedText,
            UTType("net.daringfireball.markdown") ?? .plainText,
        ]
        guard panel.runModal() == .OK else { return }
        for url in panel.urls {
            viewModel.addAttachment(url: url)
        }
    }
}
