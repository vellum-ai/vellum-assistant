import SwiftUI
import VellumAssistantShared

struct ComposerSection: View {
    @Binding var inputText: String
    let isSending: Bool
    var isAssistantBusy: Bool = false
    let hasPendingConfirmation: Bool
    var onAllowPendingConfirmation: (() -> Void)? = nil
    let isRecording: Bool
    let suggestion: String?
    let pendingAttachments: [ChatAttachment]
    var isLoadingAttachment: Bool = false
    let onSend: () -> Void
    let onStop: () -> Void
    let onAcceptSuggestion: () -> Void
    let onAttach: () -> Void
    let onRemoveAttachment: (String) -> Void
    let onPaste: () -> Void
    let onMicrophoneToggle: () -> Void
    let watchSession: WatchSession?
    let onStopWatch: () -> Void
    var voiceModeManager: VoiceModeManager? = nil
    var voiceService: OpenAIVoiceService? = nil
    var onEndVoiceMode: (() -> Void)? = nil
    var recordingAmplitude: Float = 0
    var onDictateToggle: (() -> Void)? = nil
    var onVoiceModeToggle: (() -> Void)? = nil
    var conversationId: UUID?
    var isInteractionEnabled: Bool = true
    var contextWindowFillRatio: Double? = nil
    var contextWindowTokens: Int? = nil
    var contextWindowMaxTokens: Int? = nil
    var conversationHostAccessControl: ConversationHostAccessControlConfiguration? = nil

    var body: some View {
        VStack(spacing: 0) {
            if let watchSession, watchSession.state == .capturing {
                WatchProgressView(session: watchSession, onStop: onStopWatch)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.bottom, VSpacing.sm)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if let conversationHostAccessControl {
                ConversationHostAccessControl(configuration: conversationHostAccessControl)
                    .padding(.bottom, VSpacing.sm)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            ComposerView(
                inputText: $inputText,
                isSending: isSending,
                isAssistantBusy: isAssistantBusy,
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
                onMicrophoneToggle: onMicrophoneToggle,
                voiceModeManager: voiceModeManager,
                voiceService: voiceService,
                onEndVoiceMode: onEndVoiceMode,
                recordingAmplitude: recordingAmplitude,
                onDictateToggle: onDictateToggle,
                onVoiceModeToggle: onVoiceModeToggle,
                placeholderText: isAssistantBusy ? "Working on it..." : "What would you like to do?",
                conversationId: conversationId,
                isInteractionEnabled: isInteractionEnabled,
                contextWindowFillRatio: contextWindowFillRatio,
                contextWindowTokens: contextWindowTokens,
                contextWindowMaxTokens: contextWindowMaxTokens
            )
        }
        .background(
            LinearGradient(
                stops: [
                    .init(color: VColor.surfaceBase.opacity(0), location: 0),
                    .init(color: VColor.surfaceBase.opacity(0.5), location: 0.5),
                    .init(color: VColor.surfaceBase.opacity(0.65), location: 1.0)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .allowsHitTesting(false)
        )
    }
}
