import SwiftUI
import VellumAssistantShared

struct MessageBubbleView: View {
    let message: ChatMessage

    var body: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            if message.role == .user {
                Spacer(minLength: 60)
            }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: VSpacing.xs) {
                // Message text
                Text(message.text)
                    .font(VFont.body)
                    .foregroundColor(message.role == .user ? VColor.background : VColor.textPrimary)
                    .padding(VSpacing.md)
                    .background(
                        message.role == .user
                            ? VColor.accent
                            : VColor.surface
                    )
                    .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))

                // Tool call chips
                if !message.toolCalls.isEmpty {
                    ForEach(message.toolCalls) { toolCall in
                        ToolCallChip(toolCall: toolCall)
                    }
                }

                // Streaming indicator
                if message.isStreaming {
                    HStack(spacing: VSpacing.xs) {
                        ForEach(0..<3) { index in
                            Circle()
                                .fill(VColor.textSecondary)
                                .frame(width: 4, height: 4)
                                .scaleEffect(streamingScale(for: index))
                                .animation(
                                    .easeInOut(duration: 0.6)
                                    .repeatForever()
                                    .delay(Double(index) * 0.2),
                                    value: message.isStreaming
                                )
                        }
                    }
                    .padding(.horizontal, VSpacing.sm)
                }
            }

            if message.role == .assistant {
                Spacer(minLength: 60)
            }
        }
    }

    private func streamingScale(for index: Int) -> CGFloat {
        return message.isStreaming ? 1.4 : 1.0
    }
}

#Preview("User Message") {
    VStack(spacing: VSpacing.md) {
        MessageBubbleView(message: ChatMessage(
            role: .user,
            text: "Hello! Can you help me with something?"
        ))
    }
    .padding()
    .background(VColor.background)
}

#Preview("Assistant Message") {
    VStack(spacing: VSpacing.md) {
        MessageBubbleView(message: ChatMessage(
            role: .assistant,
            text: "Of course! I'd be happy to help. What do you need assistance with?"
        ))
    }
    .padding()
    .background(VColor.background)
}

#Preview("Streaming") {
    VStack(spacing: VSpacing.md) {
        MessageBubbleView(message: ChatMessage(
            role: .assistant,
            text: "I'm thinking about",
            isStreaming: true
        ))
    }
    .padding()
    .background(VColor.background)
}
