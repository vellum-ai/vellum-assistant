import VellumAssistantShared
import SwiftUI

struct InterviewChatView: View {
    let messages: [InterviewMessage]
    let inputText: String
    let isThinking: Bool
    let isStreaming: Bool
    var onChipTap: ((String) -> Void)? = nil

    /// Whether suggestion chips should be visible.
    /// Only show after the first assistant greeting has fully completed (not while streaming).
    private var showSuggestionChips: Bool {
        let hasGreeting = messages.contains { $0.role == .assistant }
        let hasUserMessage = messages.contains { $0.role == .user }
        return hasGreeting && !hasUserMessage && inputText.isEmpty && !isStreaming
    }

    var body: some View {
        VStack(spacing: 0) {
            messageList
            if showSuggestionChips {
                suggestionChips
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .animation(VAnimation.standard, value: showSuggestionChips)
    }

    // MARK: - Message List

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: VSpacing.md) {
                    ForEach(messages) { message in
                        MessageBubble(message: message)
                            .id(message.id)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }

                    if isThinking {
                        TypingIndicator()
                            .id("typing-indicator")
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)
            }
            .onChange(of: messages.count) {
                withAnimation(VAnimation.standard) {
                    if let lastMessage = messages.last {
                        proxy.scrollTo(lastMessage.id, anchor: .bottom)
                    }
                }
            }
            .onChange(of: isThinking) {
                if isThinking {
                    withAnimation(VAnimation.standard) {
                        proxy.scrollTo("typing-indicator", anchor: .bottom)
                    }
                }
            }
        }
    }

    // MARK: - Suggestion Chips

    private static let chipTexts = [
        "Automate repetitive tasks",
        "Research & summarize faster",
        "Help me write & edit",
        "Just exploring what\u{2019}s possible",
    ]

    private var suggestionChips: some View {
        VStack(spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                ForEach(Self.chipTexts.prefix(2), id: \.self) { chip in
                    chipButton(chip)
                }
            }
            HStack(spacing: VSpacing.sm) {
                ForEach(Self.chipTexts.suffix(2), id: \.self) { chip in
                    chipButton(chip)
                }
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
    }

    private func chipButton(_ chip: String) -> some View {
        Button {
            onChipTap?(chip)
        } label: {
            Text(chip)
                .font(VFont.caption)
                .foregroundColor(VColor.contentSecondary)
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.sm)
                .background(VColor.surfaceBase)
                .clipShape(Capsule())
                .overlay(
                    Capsule()
                        .stroke(VColor.borderBase.opacity(0.5), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .pointerCursor()
    }
}

// MARK: - Message Bubble

private struct MessageBubble: View {
    let message: InterviewMessage

    private var isAssistant: Bool { message.role == .assistant }

    var body: some View {
        HStack {
            if !isAssistant { Spacer(minLength: 0) }

            Text(message.text)
                .font(VFont.body)
                .foregroundColor(isAssistant ? VColor.contentDefault : VColor.auxWhite)
                .textSelection(.enabled)
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(bubbleFill)
                )
                .if(!isAssistant) { view in
                    view.vShadow(VShadow.accentGlow)
                }
                .frame(maxWidth: maxBubbleWidth, alignment: isAssistant ? .leading : .trailing)

            if isAssistant { Spacer(minLength: 0) }
        }
    }

    private var bubbleFill: some ShapeStyle {
        if isAssistant {
            return AnyShapeStyle(VColor.surfaceBase.opacity(0.5))
        } else {
            return AnyShapeStyle(
                LinearGradient(
                    colors: [Meadow.userBubbleGradientStart, Meadow.userBubbleGradientEnd],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            )
        }
    }

    private var maxBubbleWidth: CGFloat {
        340
    }
}

// MARK: - Typing Indicator

private struct TypingIndicator: View {
    @State private var phase: Int = 0
    @State private var timer: Timer?

    var body: some View {
        HStack {
            HStack(spacing: VSpacing.xs) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(VColor.contentSecondary)
                        .frame(width: 6, height: 6)
                        .opacity(dotOpacity(for: index))
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.surfaceBase.opacity(0.5))
            )

            Spacer()
        }
        .onAppear { startAnimation() }
        .onDisappear { timer?.invalidate() }
    }

    private func dotOpacity(for index: Int) -> Double {
        phase == index ? 1.0 : 0.4
    }

    private func startAnimation() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
            withAnimation(.easeInOut(duration: 0.3)) {
                phase = (phase + 1) % 3
            }
        }
    }
}

// MARK: - Preview

#if DEBUG

private struct InterviewChatViewPreviewWrapper: View {
    @State private var text = ""

    private let sampleMessages: [InterviewMessage] = [
        InterviewMessage(role: .assistant, text: "Hi there! I just hatched and I am so excited to meet you."),
        InterviewMessage(role: .user, text: "Welcome! What can you do?"),
        InterviewMessage(
            role: .assistant,
            text: "I can help you with all sorts of things -- voice conversations, taking actions on your computer, and context-aware assistance!"
        ),
        InterviewMessage(role: .user, text: "That sounds great, tell me more."),
    ]

    var body: some View {
        ZStack {
            MeadowBackground()
            OnboardingPanel {
                InterviewChatView(
                    messages: sampleMessages,
                    inputText: text,
                    isThinking: true,
                    isStreaming: false
                )
                .frame(height: 400)
            }
        }
    }
}
#endif
