import SwiftUI
import VellumAssistantShared

/// Empty state shown when a ChatView conversation has no messages.
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
    let onSend: () -> Void
    let onStop: () -> Void
    let onAcceptSuggestion: () -> Void
    let onAttach: () -> Void
    let onRemoveAttachment: (String) -> Void
    let onPaste: () -> Void
    let onFileDrop: ([URL]) -> Void
    var onDropImageData: ((Data, String?) -> Void)? = nil
    let onMicrophoneToggle: () -> Void
    var recordingAmplitude: Float = 0
    var onDictateToggle: (() -> Void)? = nil
    var onVoiceModeToggle: (() -> Void)? = nil
    var conversationId: UUID?
    var daemonGreeting: String? = nil
    var onRequestGreeting: (() -> Void)? = nil
    var conversationStarters: [ConversationStarter] = []
    var conversationStartersLoading: Bool = false
    var onSelectStarter: ((ConversationStarter) -> Void)? = nil
    var onFetchConversationStarters: (() -> Void)? = nil
    var capabilityCards: [CapabilityCard] = []
    var capabilityCardsLoading: Bool = false
    var cardCategoryStatuses: [String: CategoryStatus] = [:]
    var onSelectCard: ((CapabilityCard) -> Void)? = nil
    var onFetchCapabilityCards: (() -> Void)? = nil
    var showCapabilityFeed: Bool = false

    @State private var visible = false
    @State private var placeholder: String = placeholderTexts.randomElement()!

    // Stable random pick from SOUL.md (computed once per view lifecycle)
    @State private var soulGreeting: String? = {
        let custom = IdentityInfo.loadGreetings()
        return custom.isEmpty ? nil : custom.randomElement()!
    }()

    // The greeting to display: SOUL.md takes priority, then daemon, then nil (loading)
    private var effectiveGreeting: String? {
        soulGreeting ?? daemonGreeting
    }

    private let appearance = AvatarAppearanceManager.shared

    // MARK: - Greeting Data

    static let placeholderTexts = [
        "Ask me anything...",
        "Tell me what you need...",
        "Say the word...",
        "Go ahead, I'm listening...",
        "Type or hold Fn to talk...",
    ]

    @State private var scrolledPastHero = false

    // MARK: - Body

    var body: some View {
        if showCapabilityFeed {
            scrollableBody
        } else {
            staticBody
        }
    }

    // MARK: - Static Body (original layout, no feed)

    private var staticBody: some View {
        VStack(spacing: 0) {
            Spacer()
            Spacer()

            heroSection

            composerSection

            conversationStartersSection

            Spacer()
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear(perform: handleAppear)
        .onDisappear { visible = false }
    }

    // MARK: - Scrollable Body (hero + capability feed)

    private var scrollableBody: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 0) {
                    // Zone 1: Hero
                    VStack(spacing: 0) {
                        Spacer()
                            .frame(height: 80)

                        heroSection
                            .id("hero-composer")

                        composerSection

                        conversationStartersSection

                        // Scroll CTA
                        if !capabilityCards.isEmpty || capabilityCardsLoading {
                            ScrollCTAView {
                                withAnimation(.easeInOut(duration: 0.4)) {
                                    proxy.scrollTo("feed-top", anchor: .top)
                                }
                            }
                        }

                        // Scroll offset detector — when this goes off screen, show floating composer
                        GeometryReader { geo in
                            Color.clear
                                .preference(
                                    key: ScrollOffsetKey.self,
                                    value: geo.frame(in: .named("emptyStateScroll")).minY
                                )
                        }
                        .frame(height: 0)
                    }
                    .frame(minHeight: 400)

                    // Zone 2: Capabilities Feed
                    if !capabilityCards.isEmpty || capabilityCardsLoading {
                        Divider()
                            .padding(.horizontal, VSpacing.xl)
                            .id("feed-top")

                        CapabilitiesFeedView(
                            cards: capabilityCards,
                            categoryStatuses: cardCategoryStatuses,
                            loading: capabilityCardsLoading,
                            onCardTap: { card in
                                onSelectCard?(card)
                                withAnimation(.easeInOut(duration: 0.3)) {
                                    proxy.scrollTo("hero-composer", anchor: .top)
                                }
                            }
                        )
                        .padding(.top, VSpacing.xxxl)
                    }
                }
                .id("hero-top")
            }
            .coordinateSpace(name: "emptyStateScroll")
            .onPreferenceChange(ScrollOffsetKey.self) { offset in
                let isPastHero = offset < -200
                if isPastHero != scrolledPastHero {
                    withAnimation(VAnimation.fast) {
                        scrolledPastHero = isPastHero
                    }
                }
            }
            .overlay(alignment: .top) {
                FloatingMiniComposer(visible: scrolledPastHero) {
                    withAnimation(.easeInOut(duration: 0.3)) {
                        proxy.scrollTo("hero-composer", anchor: .top)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear(perform: handleAppear)
        .onDisappear { visible = false }
    }

    // MARK: - Shared Sections

    private var heroSection: some View {
        HStack(spacing: VSpacing.md) {
            Group {
                if let body = appearance.characterBodyShape,
                   let eyes = appearance.characterEyeStyle,
                   let color = appearance.characterColor {
                    AnimatedAvatarView(bodyShape: body, eyeStyle: eyes, color: color, size: 32)
                        .frame(width: 32, height: 32)
                } else {
                    VAvatarImage(image: appearance.chatAvatarImage, size: 32)
                }
            }

            if let greeting = effectiveGreeting {
                Text(greeting)
                    .font(.custom("Fraunces", size: 28).weight(.regular))
                    .foregroundColor(VColor.contentSecondary)
                    .multilineTextAlignment(.leading)
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: VSpacing.chatBubbleMaxWidth)
        .animation(.easeOut(duration: 0.4), value: effectiveGreeting != nil)
        .opacity(visible ? 1 : 0)
        .scaleEffect(visible ? 1 : 0.8)
        .padding(.horizontal, VSpacing.xl)
        .padding(.bottom, VSpacing.xl)
    }

    private var composerSection: some View {
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
            recordingAmplitude: recordingAmplitude,
            onDictateToggle: onDictateToggle,
            onVoiceModeToggle: onVoiceModeToggle,
            placeholderText: placeholder,
            conversationId: conversationId
        )
        .frame(maxWidth: VSpacing.chatBubbleMaxWidth)
        .opacity(visible ? 1 : 0)
        .offset(y: visible ? 0 : 10)
    }

    @ViewBuilder
    private var conversationStartersSection: some View {
        if !conversationStarters.isEmpty {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: VSpacing.sm) {
                ForEach(conversationStarters.prefix(4)) { starter in
                    ConversationStarterChip(label: starter.label, fullPrompt: starter.prompt) {
                        onSelectStarter?(starter)
                    }
                }
            }
            .frame(maxWidth: VSpacing.chatBubbleMaxWidth)
            .padding(.top, VSpacing.xxxl)
            .opacity(visible ? 1 : 0)
            .offset(y: visible ? 0 : 10)
        } else if conversationStartersLoading {
            HStack(spacing: VSpacing.sm) {
                Group {
                    if let body = appearance.characterBodyShape,
                       let eyes = appearance.characterEyeStyle,
                       let color = appearance.characterColor {
                        AnimatedAvatarView(bodyShape: body, eyeStyle: eyes, color: color, size: 16)
                            .frame(width: 16, height: 16)
                    } else {
                        ProgressView()
                            .controlSize(.small)
                    }
                }
                Text("Getting some ideas\u{2026}")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }
            .frame(maxWidth: VSpacing.chatBubbleMaxWidth)
            .padding(.top, VSpacing.xxxl)
            .opacity(visible ? 1 : 0)
            .offset(y: visible ? 0 : 10)
        }
    }

    private func handleAppear() {
        if soulGreeting == nil {
            onRequestGreeting?()
        }
        onFetchConversationStarters?()
        if showCapabilityFeed {
            onFetchCapabilityCards?()
        }
        withAnimation(.easeOut(duration: 0.5)) {
            visible = true
        }
    }

}

// MARK: - Conversation Starter Chip

struct ConversationStarterChip: View {
    let label: String
    let fullPrompt: String
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(isHovered ? VColor.surfaceOverlay : VColor.surfaceActive)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.borderBase, lineWidth: 0.5)
                )
                .contentShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
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
    let onSend: () -> Void
    let onStop: () -> Void
    let onAcceptSuggestion: () -> Void
    let onAttach: () -> Void
    let onRemoveAttachment: (String) -> Void
    let onPaste: () -> Void
    let onFileDrop: ([URL]) -> Void
    var onDropImageData: ((Data, String?) -> Void)? = nil
    let onMicrophoneToggle: () -> Void
    var recordingAmplitude: Float = 0
    var onDictateToggle: (() -> Void)? = nil
    var onVoiceModeToggle: (() -> Void)? = nil
    var conversationId: UUID?

    var body: some View {
        VStack(spacing: 0) {
            Spacer()
            Spacer()

            Text("🍃")
                .font(.system(size: 48))
                .padding(.bottom, VSpacing.lg)

            Text("Temporary Chat")
                .font(.system(size: 28, weight: .medium))
                .foregroundColor(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .padding(.bottom, VSpacing.sm)

            Text("Memory is disabled for this chat, and it won\u{2019}t appear in your history.")
                .font(VFont.body)
                .foregroundColor(VColor.contentTertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 400)
                .padding(.horizontal, VSpacing.xl)
                .padding(.bottom, VSpacing.xxl)

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
                recordingAmplitude: recordingAmplitude,
                onDictateToggle: onDictateToggle,
                onVoiceModeToggle: onVoiceModeToggle,
                placeholderText: "Ask anything...",
                conversationId: conversationId
            )
            .frame(maxWidth: VSpacing.chatBubbleMaxWidth)

            Spacer()
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RadialGradient(
                gradient: Gradient(colors: [
                    VColor.primaryBase.opacity(0.07),
                    VColor.primaryBase.opacity(0.02),
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

// MARK: - Scroll Offset Tracking

private struct ScrollOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
