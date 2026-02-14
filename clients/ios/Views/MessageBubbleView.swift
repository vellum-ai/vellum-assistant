import SwiftUI
import VellumAssistantShared

struct MessageBubbleView: View {
    let message: ChatMessage
    @State private var animationPhase: Double = 0

    var body: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            if message.role == .user {
                Spacer(minLength: 60)
            }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: VSpacing.xs) {
                // Message text
                if !message.text.isEmpty {
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
                }

                // Tool call chips
                if !message.toolCalls.isEmpty {
                    ForEach(message.toolCalls) { toolCall in
                        ToolCallChip(toolCall: toolCall)
                    }
                }

                // Streaming indicator
                if message.isStreaming {
                    TimelineView(.animation(minimumInterval: 0.05)) { context in
                        HStack(spacing: VSpacing.xs) {
                            ForEach(0..<3) { index in
                                Circle()
                                    .fill(VColor.textSecondary)
                                    .frame(width: 4, height: 4)
                                    .scaleEffect(streamingScale(for: index, at: context.date))
                            }
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

    private func streamingScale(for index: Int, at date: Date) -> CGFloat {
        let time = date.timeIntervalSince1970
        let phase = (time + Double(index) * 0.3).truncatingRemainder(dividingBy: 1.2)
        let normalized = phase / 1.2
        return 1.0 + 0.4 * sin(normalized * 2 * .pi)
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
