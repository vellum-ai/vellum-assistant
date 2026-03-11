import VellumAssistantShared
import SwiftUI

struct TextResponseView: View {
    @ObservedObject var session: TextSession
    @Bindable var inputState: ConversationInputState
    var onClose: (() -> Void)?
    @State private var appearance = AvatarAppearanceManager.shared

    /// Whether the session is actively processing (thinking or streaming).
    private var isActiveState: Bool {
        switch session.state {
        case .thinking, .streaming:
            return true
        default:
            return false
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            // Scrollable message list
            messageList

            // Input area (only when ready)
            if session.state == .ready {
                inputArea
            }

            // Thinking indicator (bouncing dots)
            if case .thinking = session.state {
                thinkingIndicator
            }

            // Stop button (when thinking or streaming)
            if isActiveState {
                stopButton
            }

            // Error state
            if case .failed(let reason) = session.state {
                HStack(spacing: 6) {
                    VIconView(.circleX, size: 14)
                        .foregroundStyle(.red)
                    Text(reason)
                        .font(VFont.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)
            }

            // Cancelled state
            if case .cancelled = session.state {
                Text("Cancelled")
                    .font(VFont.caption.bold())
                    .foregroundStyle(.orange)
                    .padding(.horizontal, VSpacing.lg)
                    .padding(.vertical, VSpacing.md)
            }
        }
        .overlay(alignment: .topTrailing) {
            Button {
                onClose?()
            } label: {
                VIconView(.x, size: 12)
                    .foregroundColor(VColor.textMuted)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close")
            .padding(VSpacing.lg)
        }
        .frame(minWidth: 300, maxWidth: 600)
    }

    // MARK: - Message List

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: VSpacing.md) {
                    ForEach(session.messages) { message in
                        ConversationBubble(message: message)
                            .id(message.id)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }

                    // Streaming bubble — show accumulated text as it arrives
                    if case .streaming(let text) = session.state {
                        streamingBubble(text: text)
                            .id("streaming-bubble")
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                    }
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)
            }
            .frame(maxHeight: .infinity)
            .onChange(of: session.messages.count) {
                withAnimation(VAnimation.standard) {
                    if let lastMessage = session.messages.last {
                        proxy.scrollTo(lastMessage.id, anchor: .bottom)
                    }
                }
            }
            .onChange(of: session.state) {
                withAnimation(VAnimation.standard) {
                    switch session.state {
                    case .streaming:
                        proxy.scrollTo("streaming-bubble", anchor: .bottom)
                    case .thinking:
                        if let lastMessage = session.messages.last {
                            proxy.scrollTo(lastMessage.id, anchor: .bottom)
                        }
                    default:
                        if let lastMessage = session.messages.last {
                            proxy.scrollTo(lastMessage.id, anchor: .bottom)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Streaming Bubble

    private func streamingBubble(text: String) -> some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            assistantAvatar

            Text(Self.markdownString(text))
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .textSelection(.enabled)
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(VColor.surface.opacity(0.5))
                )
                .frame(maxWidth: 320, alignment: .leading)

            Spacer(minLength: 0)
        }
    }

    // MARK: - Thinking Indicator

    private var thinkingIndicator: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            assistantAvatar

            BouncingDots()
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(VColor.surface.opacity(0.5))
                )

            Spacer(minLength: 0)
        }
        .id("typing-indicator")
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Input Area

    private var inputArea: some View {
        HStack(spacing: VSpacing.sm) {
            VTextField(
                placeholder: "Reply...",
                text: $inputState.inputText,
                onSubmit: sendMessage
            )

            // Mic indicator — shows when Fn-hold voice input is active
            if inputState.isRecording {
                Image(systemName: "mic.fill")
                    .foregroundStyle(.red)
                    .font(.system(size: 14))
                    .symbolEffect(.pulse)
            }

            // Send button
            Button(action: sendMessage) {
                VIconView(.arrowUp, size: 12)
                    .foregroundColor(.white)
                    .frame(width: 28, height: 28)
                    .background(
                        Circle()
                            .fill(inputState.inputText.isEmpty ? VColor.sendButton.opacity(0.4) : VColor.sendButton)
                    )
            }
            .buttonStyle(.plain)
            .disabled(inputState.inputText.isEmpty)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
    }

    // MARK: - Stop Button

    private var stopButton: some View {
        HStack {
            Spacer()
            Button("Stop") {
                session.cancel()
            }
            .buttonStyle(.bordered)
            .tint(.red)
            .controlSize(.small)
            Spacer()
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.bottom, VSpacing.md)
    }

    // MARK: - Assistant Avatar

    private var assistantAvatar: some View {
        VAvatarImage(image: appearance.chatAvatarImage, size: 24)
    }

    // MARK: - Markdown

    static func markdownString(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: text, options: options))
            ?? AttributedString(text)
    }

    // MARK: - Helpers

    private func sendMessage() {
        let text = inputState.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        inputState.inputText = ""
        session.sendFollowUp(text: text)
    }
}

// MARK: - Conversation Bubble

struct ConversationBubble: View {
    let message: ConversationMessage
    @State private var appearance = AvatarAppearanceManager.shared

    private var isAssistant: Bool { message.role == .assistant }

    var body: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            if isAssistant {
                assistantAvatar
            } else {
                Spacer(minLength: 0)
            }

            Text(Self.markdownString(message.text))
                .font(VFont.body)
                .foregroundColor(isAssistant ? VColor.textPrimary : .white)
                .tint(isAssistant ? VColor.accent : .white)
                .if(isAssistant) { view in
                    view.textSelection(.enabled)
                }
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.md)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .fill(bubbleFill)
                )
                .if(!isAssistant) { view in
                    view.vShadow(VShadow.accentGlow)
                }
                .frame(maxWidth: 320, alignment: isAssistant ? .leading : .trailing)

            if isAssistant {
                Spacer(minLength: 0)
            }
        }
    }

    static func markdownString(_ text: String) -> AttributedString {
        TextResponseView.markdownString(text)
    }

    private var bubbleFill: some ShapeStyle {
        if isAssistant {
            return AnyShapeStyle(VColor.surface.opacity(0.5))
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

    private var assistantAvatar: some View {
        VAvatarImage(image: appearance.chatAvatarImage, size: 24)
    }
}

// MARK: - Bouncing Dots

struct BouncingDots: View {
    @State private var phase: Int = 0
    @State private var timer: Timer?

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(VColor.textSecondary)
                    .frame(width: 6, height: 6)
                    .opacity(phase == index ? 1.0 : 0.4)
            }
        }
        .onAppear { startAnimation() }
        .onDisappear { timer?.invalidate() }
    }

    private func startAnimation() {
        timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
            withAnimation(.easeInOut(duration: 0.3)) {
                phase = (phase + 1) % 3
            }
        }
    }
}

// MARK: - Conditional Modifier

extension View {
    @ViewBuilder
    func `if`<Content: View>(_ condition: Bool, transform: (Self) -> Content) -> some View {
        if condition {
            transform(self)
        } else {
            self
        }
    }
}
