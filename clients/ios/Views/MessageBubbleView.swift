#if canImport(UIKit)
import os
import SwiftUI
import VellumAssistantShared

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "MessageBubbleView"
)

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
                            log.debug("Add trust rule not yet implemented")
                            return false
                        }
                    )
                } else if message.role == .assistant && hasInterleavedContent {
                    interleavedContent
                } else {
                    // Pre-text tool calls render above the bubble
                    let preTextCalls = message.toolCalls.filter { $0.arrivedBeforeText }
                    if !preTextCalls.isEmpty {
                        ToolCallProgressBar(toolCalls: preTextCalls)
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

                    // Post-text tool calls render below the bubble
                    let postTextCalls = message.toolCalls.filter { !$0.arrivedBeforeText }
                    if !postTextCalls.isEmpty {
                        ToolCallProgressBar(toolCalls: postTextCalls)
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

    private var hasInterleavedContent: Bool {
        guard message.contentOrder.count > 1 else { return false }
        var hasText = false
        var hasNonText = false
        for ref in message.contentOrder {
            switch ref {
            case .text: hasText = true
            case .toolCall, .surface: hasNonText = true
            }
            if hasText && hasNonText { return true }
        }
        return false
    }

    private enum ContentGroup {
        case text(Int)
        case toolCalls([Int])
        case surface(Int)
    }

    private func groupContentBlocks() -> [ContentGroup] {
        var groups: [ContentGroup] = []
        for ref in message.contentOrder {
            switch ref {
            case .text(let i):
                groups.append(.text(i))
            case .toolCall(let i):
                if case .toolCalls(let indices) = groups.last {
                    groups[groups.count - 1] = .toolCalls(indices + [i])
                } else {
                    groups.append(.toolCalls([i]))
                }
            case .surface(let i):
                groups.append(.surface(i))
            }
        }
        return groups
    }

    @ViewBuilder
    private var interleavedContent: some View {
        let groups = groupContentBlocks()
        ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
            switch group {
            case .text(let i):
                if i < message.textSegments.count {
                    let segmentText = message.textSegments[i].trimmingCharacters(in: .whitespacesAndNewlines)
                    if !segmentText.isEmpty {
                        Text(segmentText)
                            .font(VFont.body)
                            .foregroundColor(VColor.textPrimary)
                            .padding(VSpacing.md)
                            .background(VColor.surface)
                            .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                    }
                }
            case .toolCalls(let indices):
                let calls = indices.compactMap { i in i < message.toolCalls.count ? message.toolCalls[i] : nil }
                if !calls.isEmpty {
                    ToolCallProgressBar(toolCalls: calls)
                }
            case .surface(let i):
                if i < message.inlineSurfaces.count {
                    InlineSurfaceRouter(
                        surface: message.inlineSurfaces[i],
                        onAction: { surfaceId, actionId, data in
                            onSurfaceAction?(surfaceId, actionId, data)
                        }
                    )
                }
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
                log.debug("Preview: Confirmation \(decision) for \(requestId)")
            },
            onSurfaceAction: nil
        )
    }
    .padding()
    .background(VColor.background)
}
#endif
