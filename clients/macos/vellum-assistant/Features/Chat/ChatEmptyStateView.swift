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

    @State private var visible = false
    @State private var fallbackPlaceholder: String = placeholderTexts.randomElement()!

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
        "What would help right now?",
        "What should we tackle?",
        "Say the word...",
        "Go ahead, I'm listening...",
        "Type or hold Fn to talk...",
    ]
    // MARK: - Body

    var body: some View {
        staticBody
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
                    .font(VFont.largeTitle)
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
            placeholderText: fallbackPlaceholder,
            conversationId: conversationId
        )
        .frame(maxWidth: VSpacing.chatBubbleMaxWidth)
        .opacity(visible ? 1 : 0)
        .offset(y: visible ? 0 : 10)
    }

    @ViewBuilder
    private var conversationStartersSection: some View {
        if !conversationStarters.isEmpty {
            ConversationStarterPillRow(
                starters: conversationStarters,
                onSelect: { starter in onSelectStarter?(starter) }
            )
            .frame(maxWidth: VSpacing.chatBubbleMaxWidth)
            .padding(.top, VSpacing.xxl)
            .opacity(visible ? 1 : 0)
            .offset(y: visible ? 0 : 10)
        } else if conversationStartersLoading {
            Text("Getting some ideas\u{2026}")
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
                .frame(maxWidth: VSpacing.chatBubbleMaxWidth)
                .padding(.top, VSpacing.xxl)
                .opacity(visible ? 1 : 0)
                .offset(y: visible ? 0 : 10)
        }
    }

    private func handleAppear() {
        if soulGreeting == nil {
            onRequestGreeting?()
        }
        onFetchConversationStarters?()
        withAnimation(.easeOut(duration: 0.5)) {
            visible = true
        }
    }

}

// MARK: - Conversation Starter Pill Row

/// Two-column grid of conversation starter pills, always showing 2 or 4 items.
/// Each pill stretches to fill its column so both columns are equal width.
struct ConversationStarterPillRow: View {
    let starters: [ConversationStarter]
    let onSelect: (ConversationStarter) -> Void

    /// Round down to the nearest even number, capped at 4.
    private var visibleStarters: [ConversationStarter] {
        let count = min(starters.count, 4)
        let evenCount = count - (count % 2)
        guard evenCount > 0 else { return [] }
        return Array(starters.prefix(evenCount))
    }

    private let columns = [
        GridItem(.flexible(), spacing: VSpacing.sm),
        GridItem(.flexible(), spacing: VSpacing.sm),
    ]

    var body: some View {
        LazyVGrid(columns: columns, spacing: VSpacing.sm) {
            ForEach(visibleStarters) { starter in
                ConversationStarterPill(label: starter.label) {
                    onSelect(starter)
                }
                .frame(maxWidth: .infinity)
            }
        }
    }
}

/// A single conversation starter pill with warm hover/press feedback.
struct ConversationStarterPill: View {
    let label: String
    let action: () -> Void

    @State private var isHovered = false
    @State private var isPressed = false

    private var fillColor: Color {
        if isPressed { return VColor.borderBase.opacity(0.5) }
        if isHovered { return VColor.borderBase.opacity(0.4) }
        return VColor.borderBase.opacity(0.3)
    }

    private var borderColor: Color {
        isHovered ? VColor.borderHover.opacity(0.5) : VColor.borderBase.opacity(0.5)
    }

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(VFont.body)
                .foregroundColor(isHovered ? VColor.contentDefault : VColor.contentSecondary)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(fillColor)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(borderColor, lineWidth: 0.5)
                )
                .contentShape(RoundedRectangle(cornerRadius: VRadius.md))
        }
        .buttonStyle(PillButtonStyle(isPressed: $isPressed))
        .onHover { isHovered = $0 }
        .animation(VAnimation.fast, value: isHovered)
        .animation(VAnimation.snappy, value: isPressed)
        .accessibilityLabel(label)
    }
}

/// Button style that tracks press state without overriding pill appearance.
private struct PillButtonStyle: ButtonStyle {
    @Binding var isPressed: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .onChange(of: configuration.isPressed) { _, newValue in
                isPressed = newValue
            }
    }
}

/// Simple flow layout that wraps children horizontally.
private struct FlowLayout: Layout {
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = arrange(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(proposal: proposal, subviews: subviews)
        for (index, position) in result.positions.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + position.x, y: bounds.minY + position.y),
                proposal: ProposedViewSize(result.sizes[index])
            )
        }
    }

    private struct ArrangeResult {
        var size: CGSize
        var positions: [CGPoint]
        var sizes: [CGSize]
    }

    private func arrange(proposal: ProposedViewSize, subviews: Subviews) -> ArrangeResult {
        let maxWidth = proposal.width ?? .infinity
        var positions: [CGPoint] = []
        var sizes: [CGSize] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var totalWidth: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x + size.width > maxWidth, x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            sizes.append(size)
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
            totalWidth = max(totalWidth, x - spacing)
        }

        return ArrangeResult(
            size: CGSize(width: totalWidth, height: y + rowHeight),
            positions: positions,
            sizes: sizes
        )
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
