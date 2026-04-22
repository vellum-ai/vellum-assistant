import SwiftUI
import VellumAssistantShared

// MARK: - MessageCellView

/// Per-message cell extracted from the ForEach body so SwiftUI has a typed
/// struct boundary for diffing: when all `let` inputs are equal, SwiftUI can
/// skip re-evaluating the body during LazySubviewPlacements.updateValue.
struct MessageCellView: View, Equatable {
    static func == (lhs: MessageCellView, rhs: MessageCellView) -> Bool {
        lhs.message == rhs.message
            && lhs.showTimestamp == rhs.showTimestamp
            && lhs.nextDecidedConfirmation == rhs.nextDecidedConfirmation
            && lhs.isConfirmationRenderedInline == rhs.isConfirmationRenderedInline
            && lhs.hasPrecedingAssistant == rhs.hasPrecedingAssistant
            && lhs.activePendingRequestId == rhs.activePendingRequestId
            && lhs.subagentsByParent[lhs.message.id] == rhs.subagentsByParent[rhs.message.id]
            && lhs.isLatestAssistantMessage == rhs.isLatestAssistantMessage
            && lhs.typographyGeneration == rhs.typographyGeneration
            && lhs.isProcessingAfterTools == rhs.isProcessingAfterTools
            && lhs.processingStatusText == rhs.processingStatusText
            && lhs.isStreamingContinuation == rhs.isStreamingContinuation
            && lhs.hideInlineAvatar == rhs.hideInlineAvatar
            && lhs.showAnchoredThinkingIndicator == rhs.showAnchoredThinkingIndicator
            && lhs.anchoredThinkingLabel == rhs.anchoredThinkingLabel
            && lhs.dismissedDocumentSurfaceIds == rhs.dismissedDocumentSurfaceIds
            && lhs.activeSurfaceId == rhs.activeSurfaceId
            && lhs.isHighlighted == rhs.isHighlighted
            && lhs.selectedModel == rhs.selectedModel
            && lhs.configuredProviders == rhs.configuredProviders
            && (lhs.providerCatalogHash != rhs.providerCatalogHash ? false
                : lhs.providerCatalog.count == rhs.providerCatalog.count
                  && zip(lhs.providerCatalog, rhs.providerCatalog).allSatisfy({ $0.id == $1.id && $0.displayName == $1.displayName && $0.models.count == $1.models.count && zip($0.models, $1.models).allSatisfy({ $0.id == $1.id && $0.displayName == $1.displayName }) }))
            && lhs.isTTSEnabled == rhs.isTTSEnabled
            && lhs.mediaEmbedSettings == rhs.mediaEmbedSettings
    }

    let message: ChatMessage
    let showTimestamp: Bool
    let nextDecidedConfirmation: ToolConfirmationData?
    let isConfirmationRenderedInline: Bool
    let hasPrecedingAssistant: Bool
    let activePendingRequestId: String?
    let subagentsByParent: [UUID: [SubagentInfo]]
    let isLatestAssistantMessage: Bool
    let typographyGeneration: Int
    let isProcessingAfterTools: Bool
    let processingStatusText: String?
    let isStreamingContinuation: Bool
    let hideInlineAvatar: Bool
    let showAnchoredThinkingIndicator: Bool
    let anchoredThinkingLabel: String
    let dismissedDocumentSurfaceIds: Set<String>
    let activeSurfaceId: String?
    let isHighlighted: Bool
    let mediaEmbedSettings: MediaEmbedResolverSettings?
    var onConfirmationAllow: ((String) -> Void)?
    var onConfirmationDeny: ((String) -> Void)?
    var onAlwaysAllow: ((String, String, String, String) -> Void)?
    var onTemporaryAllow: ((String, String) -> Void)?
    var onGuardianAction: ((String, String) -> Void)?
    var onSurfaceAction: ((String, String, [String: AnyCodable]?) -> Void)?
    let onDismissDocumentWidget: ((String) -> Void)?
    var onForkFromMessage: ((String) -> Void)?
    var showInspectButton: Bool = false
    var isTTSEnabled: Bool = false
    var onInspectMessage: ((String?) -> Void)?
    var onRehydrateMessage: ((UUID) -> Void)?
    var onSurfaceRefetch: ((String, String) -> Void)?
    var onRetryFailedMessage: ((UUID) -> Void)?
    var onRetryConversationError: ((UUID) -> Void)?
    var onAbortSubagent: ((String) -> Void)?
    var onSubagentTap: ((String) -> Void)?
    var subagentDetailStore: SubagentDetailStore
    let selectedModel: String
    let configuredProviders: Set<String>
    let providerCatalog: [ProviderCatalogEntry]
    let providerCatalogHash: Int

    static func hashCatalog(_ catalog: [ProviderCatalogEntry]) -> Int {
        var hasher = Hasher()
        for entry in catalog {
            hasher.combine(entry.id)
            hasher.combine(entry.displayName)
            for model in entry.models {
                hasher.combine(model.id)
                hasher.combine(model.displayName)
            }
        }
        return hasher.finalize()
    }

    private func modelListView(for msg: ChatMessage) -> some View {
        ModelListBubble(currentModel: selectedModel, configuredProviders: configuredProviders, providerCatalog: providerCatalog)
    }

    private func commandListFallbackMessage(for message: ChatMessage) -> ChatMessage {
        var fallbackMessage = message
        fallbackMessage.commandList = nil
        return fallbackMessage
    }

    @ViewBuilder
    private func commandListView(for message: ChatMessage) -> some View {
        if let commandEntries = CommandListBubble.parsedEntries(from: message.text) {
            CommandListBubble(commands: commandEntries)
        } else {
            ChatBubble(
                message: commandListFallbackMessage(for: message),
                decidedConfirmation: nil,
                onSurfaceAction: onSurfaceAction ?? { _, _, _ in },
                onDismissDocumentWidget: { surfaceId in
                    onDismissDocumentWidget?(surfaceId)
                },
                dismissedDocumentSurfaceIds: dismissedDocumentSurfaceIds,
                onForkFromMessage: onForkFromMessage,
                showInspectButton: showInspectButton,
                isTTSEnabled: isTTSEnabled,
                onInspectMessage: onInspectMessage,
                onSurfaceRefetch: onSurfaceRefetch,
                onRehydrate: (message.wasTruncated || message.isContentStripped) ? { onRehydrateMessage?(message.id) } : nil,
                mediaEmbedSettings: mediaEmbedSettings,
                onConfirmationAllow: onConfirmationAllow,
                onConfirmationDeny: onConfirmationDeny,
                onAlwaysAllow: onAlwaysAllow,
                onTemporaryAllow: onTemporaryAllow,
                activeConfirmationRequestId: activePendingRequestId,
                onRetryFailedMessage: onRetryFailedMessage,
                onRetryConversationError: message.isError ? { onRetryConversationError?(message.id) } : nil,
                isLatestAssistantMessage: isLatestAssistantMessage,
                typographyGeneration: typographyGeneration,
                isProcessingAfterTools: isProcessingAfterTools,
                processingStatusText: processingStatusText,
                isStreamingContinuation: isStreamingContinuation,
                activeSurfaceId: activeSurfaceId,
                hideInlineAvatar: hideInlineAvatar
            )
            .equatable()
        }
    }

    @ViewBuilder
    private func thinkingIndicatorRow() -> some View {
        // ⚠️ No .frame(maxWidth:) in LazyVStack cells — see AGENTS.md.
        HStack(spacing: 0) {
            RunningIndicator(
                label: anchoredThinkingLabel,
                showIcon: false
            )
            Spacer(minLength: 0)
        }
        .id("thinking-indicator")
    }

    var body: some View {
        if showTimestamp {
            TimestampDivider(date: message.timestamp)
        }

        if let confirmation = message.confirmation {
            if confirmation.state == .pending {
                if !isConfirmationRenderedInline {
                    ToolConfirmationBubble(
                        confirmation: confirmation,
                        isKeyboardActive: confirmation.requestId == activePendingRequestId,
                        isV3: MacOSClientFeatureFlagManager.shared.isEnabled("permission-controls-v3"),
                        onAllow: { onConfirmationAllow?(confirmation.requestId) },
                        onDeny: { onConfirmationDeny?(confirmation.requestId) },
                        onAlwaysAllow: onAlwaysAllow ?? { _, _, _, _ in },
                        onTemporaryAllow: onTemporaryAllow
                    )
                    .id(message.id)
                }
            } else {
                if !hasPrecedingAssistant {
                    ToolConfirmationBubble(
                        confirmation: confirmation,
                        isV3: MacOSClientFeatureFlagManager.shared.isEnabled("permission-controls-v3"),
                        onAllow: { onConfirmationAllow?(confirmation.requestId) },
                        onDeny: { onConfirmationDeny?(confirmation.requestId) },
                        onAlwaysAllow: onAlwaysAllow ?? { _, _, _, _ in },
                        onTemporaryAllow: onTemporaryAllow
                    )
                    .id(message.id)
                }
            }
        } else if message.modelList != nil {
            modelListView(for: message)
                .id(message.id)
        } else if message.commandList != nil {
            commandListView(for: message)
                .id(message.id)
        } else if let guardianDecision = message.guardianDecision {
            GuardianDecisionBubble(
                decision: guardianDecision,
                onAction: { requestId, action in
                    onGuardianAction?(requestId, action)
                }
            )
            .id(message.id)
        } else {
            ChatBubble(
                message: message,
                decidedConfirmation: nextDecidedConfirmation,
                onSurfaceAction: onSurfaceAction ?? { _, _, _ in },
                onDismissDocumentWidget: { surfaceId in
                    onDismissDocumentWidget?(surfaceId)
                },
                dismissedDocumentSurfaceIds: dismissedDocumentSurfaceIds,
                onForkFromMessage: onForkFromMessage,
                showInspectButton: showInspectButton,
                isTTSEnabled: isTTSEnabled,
                onInspectMessage: onInspectMessage,
                onSurfaceRefetch: onSurfaceRefetch,
                onRehydrate: (message.wasTruncated || message.isContentStripped) ? { onRehydrateMessage?(message.id) } : nil,
                mediaEmbedSettings: mediaEmbedSettings,
                onConfirmationAllow: onConfirmationAllow,
                onConfirmationDeny: onConfirmationDeny,
                onAlwaysAllow: onAlwaysAllow,
                onTemporaryAllow: onTemporaryAllow,
                activeConfirmationRequestId: activePendingRequestId,
                onRetryFailedMessage: onRetryFailedMessage,
                onRetryConversationError: message.isError ? { onRetryConversationError?(message.id) } : nil,
                isLatestAssistantMessage: isLatestAssistantMessage,
                typographyGeneration: typographyGeneration,
                isProcessingAfterTools: isProcessingAfterTools,
                processingStatusText: processingStatusText,
                isStreamingContinuation: isStreamingContinuation,
                activeSurfaceId: activeSurfaceId,
                hideInlineAvatar: hideInlineAvatar
            )
            .equatable()
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.primaryBase.opacity(isHighlighted ? 0.15 : 0))
                    .padding(EdgeInsets(top: -VSpacing.xs, leading: -VSpacing.sm, bottom: -VSpacing.xs, trailing: -VSpacing.sm))
            )
            .animation(VAnimation.slow, value: isHighlighted)
            .id(message.id)
        }

        ForEach(subagentsByParent[message.id] ?? []) { subagent in
            HStack(spacing: 0) {
                SubagentEventsReader(
                    store: subagentDetailStore,
                    subagent: subagent,
                    onAbort: { onAbortSubagent?(subagent.id) },
                    onTap: { onSubagentTap?(subagent.id) }
                )
                Spacer(minLength: 0)
            }
            .id("subagent-\(subagent.id)")
        }

        if showAnchoredThinkingIndicator {
            thinkingIndicatorRow()
        }
    }
}
