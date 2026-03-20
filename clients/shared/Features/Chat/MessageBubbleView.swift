import os
import SwiftUI

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "MessageBubbleView"
)

public struct MessageBubbleView: View {
    public let message: ChatMessage
    public let onConfirmationResponse: ((String, String) -> Void)?
    public let onSurfaceAction: ((String, String, [String: AnyCodable]?) -> Void)?
    /// When non-nil, a "Regenerate" option appears in the long-press context menu
    /// for the last assistant message. Pass nil when generation is in-flight.
    public let onRegenerate: (() -> Void)?
    public let onAlwaysAllow: ((String, String, String, String) -> Void)?
    /// Called when a guardian decision action button is clicked: (requestId, action).
    public let onGuardianAction: ((String, String) -> Void)?
    /// Called when a stripped surface scrolls into view and needs its data re-fetched.
    public let onSurfaceRefetch: ((String, String) -> Void)?
    /// Called when the user taps "Retry" on a per-message send failure.
    public let onRetryFailedMessage: ((UUID) -> Void)?
    /// Called when the user taps "Retry" on an inline conversation error.
    public let onRetryConversationError: (() -> Void)?
    /// Called when the user wants to fork the conversation from this persisted message.
    public let onForkFromMessage: ((String) -> Void)?

    public init(
        message: ChatMessage,
        onConfirmationResponse: ((String, String) -> Void)?,
        onSurfaceAction: ((String, String, [String: AnyCodable]?) -> Void)?,
        onRegenerate: (() -> Void)?,
        onAlwaysAllow: ((String, String, String, String) -> Void)? = nil,
        onGuardianAction: ((String, String) -> Void)? = nil,
        onSurfaceRefetch: ((String, String) -> Void)? = nil,
        onRetryFailedMessage: ((UUID) -> Void)? = nil,
        onRetryConversationError: (() -> Void)? = nil,
        onForkFromMessage: ((String) -> Void)? = nil
    ) {
        self.message = message
        self.onConfirmationResponse = onConfirmationResponse
        self.onSurfaceAction = onSurfaceAction
        self.onRegenerate = onRegenerate
        self.onAlwaysAllow = onAlwaysAllow
        self.onGuardianAction = onGuardianAction
        self.onSurfaceRefetch = onSurfaceRefetch
        self.onRetryFailedMessage = onRetryFailedMessage
        self.onRetryConversationError = onRetryConversationError
        self.onForkFromMessage = onForkFromMessage
    }

    public var body: some View {
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
                        onAlwaysAllow: { requestId, pattern, scope, decision in
                            onAlwaysAllow?(requestId, pattern, scope, decision)
                        },
                        onTemporaryAllow: { requestId, decision in
                            onConfirmationResponse?(requestId, decision)
                        }
                    )
                } else if let guardianDecision = message.guardianDecision {
                    GuardianDecisionBubble(
                        decision: guardianDecision,
                        onAction: { requestId, action in
                            onGuardianAction?(requestId, action)
                        }
                    )
                } else if message.role == .assistant && hasInterleavedContent {
                    interleavedContent
                } else {
                    // Skill invocation chip (shown above message text)
                    if let skillInvocation = message.skillInvocation {
                        SkillInvocationChip(data: skillInvocation)
                    }

                    // Pre-text tool calls render above the bubble
                    let preTextCalls = message.toolCalls.filter { $0.arrivedBeforeText }
                    if !preTextCalls.isEmpty {
                        ToolCallProgressBar(toolCalls: preTextCalls)
                    }

                    // Message text (only shown for non-confirmation messages)
                    if !message.text.isEmpty {
                        messageBubble(text: message.text, role: message.role)
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
                                },
                                onRefetch: onSurfaceRefetch
                            )
                        }
                    }
                }

                if !message.attachmentWarnings.isEmpty {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        ForEach(Array(message.attachmentWarnings.enumerated()), id: \.offset) { _, warning in
                            VInlineMessage(warning, tone: .warning)
                        }
                    }
                }

                // Offline-pending indicator: shown when the message is buffered
                // locally awaiting daemon reconnect. Replaces the streaming dots.
                if message.status == .pendingOffline {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.history, size: 11)
                            .foregroundColor(VColor.contentTertiary)
                        Text("Pending")
                            .font(VFont.small)
                            .foregroundColor(VColor.contentTertiary)
                    }
                    .padding(.horizontal, VSpacing.sm)
                }

                // Per-message send failure indicator with inline retry button
                if message.role == .user && message.status == .sendFailed {
                    HStack(spacing: VSpacing.xs) {
                        VIconView(.triangleAlert, size: 11)
                            .foregroundColor(VColor.systemNegativeStrong)
                        Text("Failed to send")
                            .font(VFont.small)
                            .foregroundColor(VColor.systemNegativeStrong)
                        Button {
                            onRetryFailedMessage?(message.id)
                        } label: {
                            Text("Retry")
                                .font(VFont.small.weight(.medium))
                                .foregroundColor(VColor.primaryBase)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, VSpacing.sm)
                }

                // Streaming indicator
                if message.isStreaming {
                    TimelineView(.animation(minimumInterval: 0.2)) { context in
                        HStack(spacing: VSpacing.xs) {
                            ForEach(0..<3, id: \.self) { index in
                                Circle()
                                    .fill(VColor.contentSecondary)
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

    var canForkFromMessage: Bool {
        onForkFromMessage != nil && message.daemonMessageId != nil && !message.isStreaming
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
        VStack(alignment: .leading, spacing: VSpacing.md) {
            ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
                switch group {
                case .text(let i):
                    if i < message.textSegments.count {
                        let segmentText = message.textSegments[i].trimmingCharacters(in: .whitespacesAndNewlines)
                        if !segmentText.isEmpty {
                            messageBubble(text: segmentText, role: message.role)
                        }
                    }
                case .toolCalls(let indices):
                    let calls = indices.compactMap { i in i < message.toolCalls.count ? message.toolCalls[i] : nil }
                    if !calls.isEmpty {
                        ToolCallProgressBar(toolCalls: calls)
                            .padding(.vertical, VSpacing.xs)
                    }
                case .surface(let i):
                    if i < message.inlineSurfaces.count {
                        InlineSurfaceRouter(
                            surface: message.inlineSurfaces[i],
                            onAction: { surfaceId, actionId, data in
                                onSurfaceAction?(surfaceId, actionId, data)
                            },
                            onRefetch: onSurfaceRefetch
                        )
                    }
                }
            }
        }
    }

    /// Render a message text bubble with markdown for assistant messages.
    @ViewBuilder
    private func messageBubble(text: String, role: ChatRole) -> some View {
        let isUser = role == .user
        if isUser {
            Text(text)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .padding(VSpacing.md)
                .background(VColor.surfaceActive)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .textSelection(.enabled)
                .contextMenu {
                    sharedContextMenu()
                }
        } else if message.isError {
            InlineChatErrorAlert(
                message: text,
                conversationError: message.conversationError,
                onRetry: onRetryConversationError
            )
            .contextMenu {
                sharedContextMenu()
            }
        } else {
            MarkdownRenderer(text: text)
                .padding(VSpacing.md)
                .background(VColor.surfaceBase)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.lg))
                .contextMenu {
                    sharedContextMenu()
                }
        }
    }

    @ViewBuilder
    private func sharedContextMenu() -> some View {
        if let onRegenerate {
            Button {
                onRegenerate()
            } label: {
                Label { Text("Regenerate") } icon: { VIconView(.rotateCcw, size: 14) }
            }
        }

        if let onForkFromMessage, let daemonMessageId = message.daemonMessageId, !message.isStreaming {
            Button {
                onForkFromMessage(daemonMessageId)
            } label: {
                Label { Text("Fork from here") } icon: { VIconView(.gitBranch, size: 14) }
            }
        }
    }

    /// Parse markdown in text using SwiftUI's native AttributedString support.
    /// Kept for backward compatibility (used by macOS ChatView and other callers).
    public static func markdownString(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: text, options: options))
            ?? AttributedString(text)
    }

    private func streamingScale(for index: Int, at date: Date) -> CGFloat {
        let time = date.timeIntervalSince1970
        let phase = (time + Double(index) * 0.3).truncatingRemainder(dividingBy: 1.2)
        let normalized = phase / 1.2
        return 1.0 + 0.4 * sin(normalized * 2 * .pi)
    }
}

