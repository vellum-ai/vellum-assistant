import SwiftUI
import VellumAssistantShared

struct ComposerSection: View, Equatable {
    static func == (lhs: ComposerSection, rhs: ComposerSection) -> Bool {
        // VoiceModeManager is @MainActor ObservableObject, not @Observable,
        // so SwiftUI cannot track its internal state changes via struct ==.
        // When voice mode is actively in use (state != .off), always
        // re-evaluate so voice-mode transitions are never stale. When voice
        // mode is off (the common text-entry case), we fall through to the
        // normal property comparison.
        //
        // assumeIsolated is safe because SwiftUI calls == on the main thread
        // during its view-diffing pass.
        let lhsVoiceActive = lhs.voiceModeManager.map { mgr in
            MainActor.assumeIsolated { mgr.state != .off }
        } ?? false
        let rhsVoiceActive = rhs.voiceModeManager.map { mgr in
            MainActor.assumeIsolated { mgr.state != .off }
        } ?? false
        if lhsVoiceActive || rhsVoiceActive {
            return false
        }

        // WatchSession is @Observable, but its .state is read conditionally
        // in body. Always re-evaluate when a session is present so capture
        // state transitions are rendered.
        if lhs.watchSession !== rhs.watchSession
            || lhs.watchSession != nil {
            return false
        }

        return lhs.inputText == rhs.inputText
            && lhs.isSending == rhs.isSending
            && lhs.isAssistantBusy == rhs.isAssistantBusy
            && lhs.hasPendingConfirmation == rhs.hasPendingConfirmation
            && lhs.isRecording == rhs.isRecording
            && lhs.suggestion == rhs.suggestion
            && lhs.pendingAttachments.map(\.id) == rhs.pendingAttachments.map(\.id)
            && lhs.isLoadingAttachment == rhs.isLoadingAttachment
            && lhs.recordingAmplitude == rhs.recordingAmplitude
            && lhs.conversationId == rhs.conversationId
            && lhs.isInteractionEnabled == rhs.isInteractionEnabled
            && lhs.contextWindowFillRatio == rhs.contextWindowFillRatio
            && lhs.contextWindowTokens == rhs.contextWindowTokens
            && lhs.contextWindowMaxTokens == rhs.contextWindowMaxTokens
            // Optional closure availability — nil vs non-nil affects which
            // buttons are rendered in the inner ComposerView.
            && (lhs.onAllowPendingConfirmation != nil) == (rhs.onAllowPendingConfirmation != nil)
            && (lhs.onEndVoiceMode != nil) == (rhs.onEndVoiceMode != nil)
            && (lhs.onDictateToggle != nil) == (rhs.onDictateToggle != nil)
            && (lhs.onVoiceModeToggle != nil) == (rhs.onVoiceModeToggle != nil)
    }

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
                contextWindowMaxTokens: contextWindowMaxTokens,
                conversationHostAccessControl: conversationHostAccessControl
            )
            .equatable()
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
