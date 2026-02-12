import SwiftUI

struct InterviewChatView: View {
    let messages: [InterviewMessage]
    @Binding var inputText: String
    let isThinking: Bool
    let onSend: () -> Void
    let onVoiceToggle: () -> Void
    let isRecording: Bool
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
            inputArea
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
        "What I do for work",
        "Something I need help with",
        "Just exploring for now",
    ]

    private var suggestionChips: some View {
        HStack(spacing: VSpacing.sm) {
            ForEach(Self.chipTexts, id: \.self) { chip in
                Button {
                    onChipTap?(chip)
                } label: {
                    Text(chip)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.sm)
                        .background(VColor.surface)
                        .clipShape(Capsule())
                        .overlay(
                            Capsule()
                                .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
                .onHover { hovering in
                    if hovering { NSCursor.pointingHand.set() }
                    else { NSCursor.arrow.set() }
                }
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Input Area

    private var inputArea: some View {
        HStack(spacing: VSpacing.sm) {
            TextField("Type a message\u{2026}", text: $inputText)
                .textFieldStyle(.plain)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .padding(VSpacing.md)
                .background(VColor.surface)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder.opacity(0.5), lineWidth: 1)
                )
                .onSubmit {
                    if !inputText.trimmingCharacters(in: .whitespaces).isEmpty {
                        onSend()
                    }
                }

            VIconButton(
                label: "Voice",
                icon: "mic.fill",
                isActive: isRecording,
                iconOnly: true,
                action: onVoiceToggle
            )

            Button(action: {
                if !inputText.trimmingCharacters(in: .whitespaces).isEmpty {
                    onSend()
                }
            }) {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.system(size: 24, weight: .medium))
                    .foregroundColor(sendButtonDisabled ? VColor.textMuted : VColor.accent)
            }
            .buttonStyle(.plain)
            .disabled(sendButtonDisabled)
            .accessibilityLabel("Send message")
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(
            VColor.surface.opacity(0.5)
                .overlay(
                    VStack {
                        Divider().background(VColor.surfaceBorder.opacity(0.4))
                        Spacer()
                    }
                )
        )
    }

    private var sendButtonDisabled: Bool {
        inputText.trimmingCharacters(in: .whitespaces).isEmpty
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
                .foregroundColor(isAssistant ? VColor.textPrimary : .white)
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(isAssistant
                              ? VColor.surface.opacity(0.5)
                              : VColor.accent)
                )
                .frame(maxWidth: maxBubbleWidth, alignment: isAssistant ? .leading : .trailing)

            if isAssistant { Spacer(minLength: 0) }
        }
    }

    private var maxBubbleWidth: CGFloat {
        // Approximate 75% of a typical container width.
        // GeometryReader-based approach is used in the parent if needed.
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
                        .fill(VColor.textSecondary)
                        .frame(width: 6, height: 6)
                        .opacity(dotOpacity(for: index))
                }
            }
            .padding(.horizontal, VSpacing.lg)
            .padding(.vertical, VSpacing.md)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.surface.opacity(0.5))
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

#Preview("InterviewChatView") {
    @Previewable @State var text = ""

    let sampleMessages: [InterviewMessage] = [
        InterviewMessage(role: .assistant, text: "Hi there! I just hatched and I am so excited to meet you."),
        InterviewMessage(role: .user, text: "Welcome! What can you do?"),
        InterviewMessage(
            role: .assistant,
            text: "I can help you with all sorts of things -- voice conversations, taking actions on your computer, and context-aware assistance!"
        ),
        InterviewMessage(role: .user, text: "That sounds great, tell me more."),
    ]

    ZStack {
        MeadowBackground()
        OnboardingPanel {
            InterviewChatView(
                messages: sampleMessages,
                inputText: $text,
                isThinking: true,
                onSend: {},
                onVoiceToggle: {},
                isRecording: false,
                isStreaming: false
            )
            .frame(height: 400)
        }
    }
    .frame(width: 600, height: 600)
}
