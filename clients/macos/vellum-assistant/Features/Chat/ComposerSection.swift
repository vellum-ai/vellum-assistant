import SwiftUI
import VellumAssistantShared

struct ComposerSection: View {
    @Binding var inputText: String
    let hasAPIKey: Bool
    let isSending: Bool
    let hasPendingConfirmation: Bool
    var onAllowPendingConfirmation: (() -> Void)? = nil
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
    let onFileDrop: ([URL]) -> Void
    var onDropImageData: ((Data, String?) -> Void)? = nil
    let onMicrophoneToggle: () -> Void
    let onDismissError: () -> Void
    let onRetrySessionError: () -> Void
    let onCopyDebugInfo: () -> Void
    let onDismissSessionError: () -> Void
    let watchSession: WatchSession?
    let onStopWatch: () -> Void
    var isLearnMode: Bool = false
    var networkEntryCount: Int = 0
    var idleHint: Bool = false
    var voiceModeManager: VoiceModeManager? = nil
    var voiceService: OpenAIVoiceService? = nil
    var onEndVoiceMode: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 0) {
            if let watchSession, watchSession.state == .capturing {
                WatchProgressView(session: watchSession, onStop: onStopWatch, isLearnMode: isLearnMode, networkEntryCount: networkEntryCount, idleHint: idleHint)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.bottom, VSpacing.sm)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if let sessionError {
                ChatSessionErrorToast(
                    error: sessionError,
                    onRetry: onRetrySessionError,
                    onCopyDebugInfo: onCopyDebugInfo,
                    onDismiss: onDismissSessionError
                )
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
                hasPendingConfirmation: hasPendingConfirmation,
                onAllowPendingConfirmation: onAllowPendingConfirmation,
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
                onFileDrop: onFileDrop,
                onDropImageData: onDropImageData,
                onMicrophoneToggle: onMicrophoneToggle,
                voiceModeManager: voiceModeManager,
                voiceService: voiceService,
                onEndVoiceMode: onEndVoiceMode,
                placeholderText: "What would you like to do?"
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
