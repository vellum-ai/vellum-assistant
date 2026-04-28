import SwiftUI
import VellumAssistantShared

struct ComposerSection: View, Equatable {
    static func == (lhs: ComposerSection, rhs: ComposerSection) -> Bool {
        // voiceModeState is a snapshot captured at struct-creation time so
        // `lhs` holds the previous value and `rhs` holds the current one.
        // Comparing snapshots (instead of reading `voiceModeManager.state`
        // live from a shared reference) keeps `==` a pure value comparison
        // and ensures transitions always invalidate the equatable view.
        if lhs.voiceModeState != .off || rhs.voiceModeState != .off {
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
            && lhs.assistantConversationId == rhs.assistantConversationId
            && lhs.draftThresholdOverride == rhs.draftThresholdOverride
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
            && (lhs.onDraftThresholdOverrideChange != nil) == (rhs.onDraftThresholdOverrideChange != nil)
            && lhs.showThresholdPicker == rhs.showThresholdPicker
            // Closure prevents Equatable conformance on the configuration; compare
            // the value-type fields that drive rendering plus nil/non-nil parity.
            && lhs.inferenceProfilePicker?.current == rhs.inferenceProfilePicker?.current
            && lhs.inferenceProfilePicker?.profiles == rhs.inferenceProfilePicker?.profiles
            && lhs.inferenceProfilePicker?.activeProfile == rhs.inferenceProfilePicker?.activeProfile
            && (lhs.inferenceProfilePicker == nil) == (rhs.inferenceProfilePicker == nil)
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
    var voiceModeState: VoiceModeManager.State = .off
    var voiceService: OpenAIVoiceService? = nil
    var onEndVoiceMode: (() -> Void)? = nil
    var recordingAmplitude: Float = 0
    var onDictateToggle: (() -> Void)? = nil
    var onVoiceModeToggle: (() -> Void)? = nil
    var conversationId: UUID?
    var assistantConversationId: String? = nil
    var draftThresholdOverride: String? = nil
    var onDraftThresholdOverrideChange: ((String?) -> Void)? = nil
    var isInteractionEnabled: Bool = true
    var contextWindowFillRatio: Double? = nil
    var contextWindowTokens: Int? = nil
    var contextWindowMaxTokens: Int? = nil
    var showThresholdPicker: Bool = false
    var inferenceProfilePicker: ChatProfilePickerConfiguration? = nil

    var body: some View {
        VStack(spacing: 0) {
            if let watchSession, watchSession.state == .capturing {
                WatchProgressView(session: watchSession, onStop: onStopWatch)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.bottom, VSpacing.sm)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .layoutHangSignpost("composer.watchProgress")
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
                voiceModeState: voiceModeState,
                voiceService: voiceService,
                onEndVoiceMode: onEndVoiceMode,
                recordingAmplitude: recordingAmplitude,
                onDictateToggle: onDictateToggle,
                onVoiceModeToggle: onVoiceModeToggle,
                placeholderText: isAssistantBusy ? "Working on it..." : "What would you like to do?",
                conversationId: conversationId,
                assistantConversationId: assistantConversationId,
                draftThresholdOverride: draftThresholdOverride,
                onDraftThresholdOverrideChange: onDraftThresholdOverrideChange,
                isInteractionEnabled: isInteractionEnabled,
                contextWindowFillRatio: contextWindowFillRatio,
                contextWindowTokens: contextWindowTokens,
                contextWindowMaxTokens: contextWindowMaxTokens,
                showThresholdPicker: showThresholdPicker,
                inferenceProfilePicker: inferenceProfilePicker
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
