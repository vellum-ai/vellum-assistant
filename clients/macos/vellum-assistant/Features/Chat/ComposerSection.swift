import SwiftUI
import VellumAssistantShared

struct ComposerSection: View {
    @Binding var inputText: String
    let hasAPIKey: Bool
    let isSending: Bool
    let isRecording: Bool
    let suggestion: String?
    let pendingAttachments: [ChatAttachment]
    var isLoadingAttachment: Bool = false
    let errorText: String?
    let sessionError: SessionError?
    let isSecretBlockError: Bool
    let onSendAnyway: () -> Void
    let isRetryableError: Bool
    let onRetryError: () -> Void
    let isConnectionError: Bool
    var hasRetryPayload: Bool = true
    var connectionDiagnosticHint: String? = nil
    let onSend: () -> Void
    let onStop: () -> Void
    let onAcceptSuggestion: () -> Void
    let onAttach: () -> Void
    let onRemoveAttachment: (String) -> Void
    let onPaste: () -> Void
    let onMicrophoneToggle: () -> Void
    let onDismissError: () -> Void
    let watchSession: WatchSession?
    let onStopWatch: () -> Void
    var isLearnMode: Bool = false
    var networkEntryCount: Int = 0
    var idleHint: Bool = false
    @Binding var editorContentHeight: CGFloat
    @Binding var isComposerExpanded: Bool

    var body: some View {
        VStack(spacing: 0) {
            if let watchSession, watchSession.state == .capturing {
                WatchProgressView(session: watchSession, onStop: onStopWatch, isLearnMode: isLearnMode, networkEntryCount: networkEntryCount, idleHint: idleHint)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.bottom, VSpacing.sm)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if let errorText, sessionError == nil {
                ChatErrorBanner(
                    text: errorText,
                    isSecretBlockError: isSecretBlockError,
                    onSendAnyway: onSendAnyway,
                    isRetryableError: isRetryableError,
                    onRetryError: onRetryError,
                    isConnectionError: isConnectionError,
                    hasRetryPayload: hasRetryPayload,
                    connectionDiagnosticHint: connectionDiagnosticHint,
                    onDismissError: onDismissError
                )
            }
            ComposerView(
                inputText: $inputText,
                hasAPIKey: hasAPIKey,
                isSending: isSending,
                isRecording: isRecording,
                suggestion: suggestion,
                pendingAttachments: pendingAttachments,
                isLoadingAttachment: isLoadingAttachment,
                onSend: onSend,
                onStop: onStop,
                onAcceptSuggestion: onAcceptSuggestion,
                onAttach: onAttach,
                onRemoveAttachment: onRemoveAttachment,
                onPaste: onPaste,
                onMicrophoneToggle: onMicrophoneToggle,
                placeholderText: "What would you like to do?",
                editorContentHeight: $editorContentHeight,
                isComposerExpanded: $isComposerExpanded
            )
        }
        .background(
            LinearGradient(
                stops: [
                    .init(color: VColor.chatBackground.opacity(0), location: 0),
                    .init(color: VColor.chatBackground.opacity(0.5), location: 0.5),
                    .init(color: VColor.chatBackground.opacity(0.65), location: 1.0)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .allowsHitTesting(false)
        )
    }
}
