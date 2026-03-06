import SwiftUI
import VellumAssistantShared

/// Empty state shown when a ChatView thread has no messages.
///
/// Manages its own animation state (fade-in/scale) and randomises
/// the greeting + placeholder text each time it appears. Embeds
/// a `ComposerView` so the user can immediately start typing.
struct ChatEmptyStateView: View {
    @Binding var inputText: String
    let hasAPIKey: Bool
    let isSending: Bool
    let isRecording: Bool
    let suggestion: String?
    let pendingAttachments: [ChatAttachment]
    var isLoadingAttachment: Bool = false
    let errorText: String?
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

    @State private var visible = false
    @State private var title: String = titles.randomElement()!
    @State private var placeholder: String = placeholderTexts.randomElement()!

    private let appearance = AvatarAppearanceManager.shared

    // MARK: - Greeting Data

    static let defaultGreetings = [
        "What are we working on?",
        "I'm here whenever you need me.",
        "What's on your mind?",
        "Let's make something happen.",
        "Ready when you are.",
    ]

    static var titles: [String] {
        let custom = IdentityInfo.loadGreetings()
        return custom.isEmpty ? defaultGreetings : custom
    }

    static let placeholderTexts = [
        "Ask me anything...",
        "Tell me what you need...",
        "Say the word...",
        "Go ahead, I'm listening...",
        "Type or hold Fn to talk...",
    ]

    // MARK: - Body

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Spacer()

            HStack(spacing: VSpacing.md) {
                Image(nsImage: appearance.chatAvatarImage)
                    .interpolation(.none)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
                    .frame(width: 32, height: 32)
                    .clipShape(Circle())

                Text(title)
                    .font(.custom("Fraunces", size: 28).weight(.regular))
                    .foregroundColor(VColor.textSecondary)
                    .multilineTextAlignment(.leading)
            }
            .frame(maxWidth: 500)
            .opacity(visible ? 1 : 0)
            .scaleEffect(visible ? 1 : 0.8)
            .padding(.horizontal, VSpacing.xl)
            .padding(.bottom, VSpacing.xl)

            VStack(spacing: 0) {
                if let errorText {
                    ChatErrorBanner(
                        text: errorText,
                        isSecretBlockError: false,
                        onSendAnyway: {},
                        isRetryableError: false,
                        onRetryError: {},
                        isConnectionError: false,

                        onDismissError: onDismissError
                    )
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous))
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.bottom, VSpacing.xs)
                }

                ComposerView(
                    inputText: $inputText,
                    hasAPIKey: hasAPIKey,
                    isSending: isSending,
                    hasPendingConfirmation: false,
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
                    placeholderText: placeholder
                )
            }
            .frame(maxWidth: 500)
            .opacity(visible ? 1 : 0)
            .offset(y: visible ? 0 : 10)

            Spacer()
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            withAnimation(.easeOut(duration: 0.5)) {
                visible = true
            }
        }
        .onDisappear {
            visible = false
        }
    }

}

// MARK: - Temporary Chat Empty State

/// Variant shown for temporary (non-persistent) chats.
struct ChatTemporaryChatEmptyStateView: View {
    @Binding var inputText: String
    let hasAPIKey: Bool
    let isSending: Bool
    let isRecording: Bool
    let suggestion: String?
    let pendingAttachments: [ChatAttachment]
    var isLoadingAttachment: Bool = false
    let errorText: String?
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

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Spacer()

            Text("🍃")
                .font(.system(size: 48))
                .padding(.bottom, VSpacing.lg)

            Text("Temporary Chat")
                .font(.system(size: 28, weight: .medium))
                .foregroundColor(VColor.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.bottom, VSpacing.sm)

            Text("Memory is disabled for this chat, and it won\u{2019}t appear in your history.")
                .font(VFont.body)
                .foregroundColor(VColor.textMuted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 400)
                .padding(.horizontal, VSpacing.xl)
                .padding(.bottom, VSpacing.xxl)

            VStack(spacing: 0) {
                if let errorText {
                    ChatErrorBanner(
                        text: errorText,
                        isSecretBlockError: false,
                        onSendAnyway: {},
                        isRetryableError: false,
                        onRetryError: {},
                        isConnectionError: false,

                        onDismissError: onDismissError
                    )
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.lg, style: .continuous))
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.bottom, VSpacing.xs)
                }

                ComposerView(
                    inputText: $inputText,
                    hasAPIKey: hasAPIKey,
                    isSending: isSending,
                    hasPendingConfirmation: false,
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
                    placeholderText: "Ask anything..."
                )
            }

            Spacer()
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RadialGradient(
                gradient: Gradient(colors: [
                    VColor.accent.opacity(0.07),
                    VColor.accent.opacity(0.02),
                    Color.clear,
                ]),
                center: .center,
                startRadius: 20,
                endRadius: 350
            )
            .offset(y: -40)
            .allowsHitTesting(false)
        )
    }
}
