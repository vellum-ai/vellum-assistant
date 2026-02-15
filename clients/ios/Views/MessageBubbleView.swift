#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

struct MessageBubbleView: View {
    let message: ChatMessage
    let onConfirmationResponse: ((String, String) -> Void)?
    let onSurfaceAction: ((String, String, [String: AnyCodable]?) -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            if message.role == .user {
                Spacer(minLength: 60)
            }

            VStack(alignment: message.role == .user ? .trailing : .leading, spacing: VSpacing.xs) {
                // Tool confirmation request (replaces message bubble for approval prompts)
                if let confirmation = message.confirmation {
                    ToolConfirmationBubble(
                        confirmation: confirmation,
                        onAllow: {
                            onConfirmationResponse?(confirmation.requestId, "allow")
                        },
                        onDeny: {
                            onConfirmationResponse?(confirmation.requestId, "deny")
                        },
                        onAddTrustRule: { _, _, _, _ in
                            print("iOS: Add trust rule not yet implemented")
                            return false
                        }
                    )
                } else {
                    // Tool calls render above text to match chronological order
                    if !message.toolCalls.isEmpty {
                        ForEach(message.toolCalls) { toolCall in
                            ToolCallChip(toolCall: toolCall)
                        }
                    }

                    // Message text (only shown for non-confirmation messages)
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

                    // Inline surfaces (cards, tables, interactive widgets)
                    if !message.inlineSurfaces.isEmpty {
                        ForEach(message.inlineSurfaces) { surface in
                            InlineSurfaceRouter(
                                surface: surface,
                                onAction: { surfaceId, actionId, data in
                                    onSurfaceAction?(surfaceId, actionId, data)
                                }
                            )
                        }
                    }
                }

                // Streaming indicator
                if message.isStreaming {
                    TimelineView(.animation(minimumInterval: 0.05)) { context in
                        HStack(spacing: VSpacing.xs) {
                            ForEach(0..<3, id: \.self) { index in
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
        MessageBubbleView(
            message: ChatMessage(
                role: .user,
                text: "Hello! Can you help me with something?"
            ),
            onConfirmationResponse: nil,
            onSurfaceAction: nil
        )
    }
    .padding()
    .background(VColor.background)
}

#Preview("Assistant Message") {
    VStack(spacing: VSpacing.md) {
        MessageBubbleView(
            message: ChatMessage(
                role: .assistant,
                text: "Of course! I'd be happy to help. What do you need assistance with?"
            ),
            onConfirmationResponse: nil,
            onSurfaceAction: nil
        )
    }
    .padding()
    .background(VColor.background)
}

#Preview("Streaming") {
    VStack(spacing: VSpacing.md) {
        MessageBubbleView(
            message: ChatMessage(
                role: .assistant,
                text: "I'm thinking about",
                isStreaming: true
            ),
            onConfirmationResponse: nil,
            onSurfaceAction: nil
        )
    }
    .padding()
    .background(VColor.background)
}

#Preview("Tool Confirmation") {
    VStack(spacing: VSpacing.md) {
        MessageBubbleView(
            message: ChatMessage(
                role: .assistant,
                text: "",
                confirmation: ToolConfirmationData(
                    requestId: "test-123",
                    toolName: "bash",
                    input: ["command": AnyCodable("rm -rf /important/data")],
                    riskLevel: "high"
                ),
                toolCalls: []
            ),
            onConfirmationResponse: { requestId, decision in
                print("Preview: Confirmation \(decision) for \(requestId)")
            },
            onSurfaceAction: nil
        )
    }
    .padding()
    .background(VColor.background)
}
#endif
