import os
import os.signpost
import SwiftUI
import VellumAssistantShared

private let stallLog = OSLog(subsystem: "com.vellum.assistant", category: "LayoutStall")

// MARK: - MessageListContentView

/// Inner rendering view that owns the expensive `LazyVStack` + `ForEach`.
///
/// `Equatable` + `.equatable()` prevents body re-evaluation when only the
/// outer `MessageListView`'s lifecycle properties (`@Binding`, `@State`,
/// `@Observable` reads) change. The outer view's body is cheap — it creates
/// this struct and applies scroll/lifecycle modifiers. This view's body is
/// expensive — it drives `LazyStack.measureEstimates` over all visible cells.
///
/// Closures and `@Observable` references (`scrollState`, `appearance`) are
/// intentionally skipped in `==` — closures are never equal, and `@Observable`
/// objects are identity-stable. Only data properties that affect rendered
/// output are compared.
///
/// - SeeAlso: [WWDC23 — Demystify SwiftUI performance](https://developer.apple.com/videos/play/wwdc2023/10160/)
/// - SeeAlso: [Airbnb — Understanding and Improving SwiftUI Performance](https://airbnb.tech/mobile/understanding-and-improving-swiftui-performance/)
struct MessageListContentView: View, Equatable {

    // MARK: - Equatable

    static func == (lhs: MessageListContentView, rhs: MessageListContentView) -> Bool {
        lhs.state.displayMessages == rhs.state.displayMessages
            && lhs.state.showTimestamp == rhs.state.showTimestamp
            && lhs.state.hasPrecedingAssistantByIndex == rhs.state.hasPrecedingAssistantByIndex
            && lhs.state.hasUserMessage == rhs.state.hasUserMessage
            && lhs.state.latestAssistantId == rhs.state.latestAssistantId
            && lhs.state.subagentsByParent == rhs.state.subagentsByParent
            && lhs.state.orphanSubagents == rhs.state.orphanSubagents
            && lhs.state.effectiveStatusText == rhs.state.effectiveStatusText
            && lhs.state.activePendingRequestId == rhs.state.activePendingRequestId
            && lhs.state.nextDecidedConfirmationByIndex == rhs.state.nextDecidedConfirmationByIndex
            && lhs.state.isConfirmationRenderedInlineByIndex == rhs.state.isConfirmationRenderedInlineByIndex
            && lhs.state.anchoredThinkingIndex == rhs.state.anchoredThinkingIndex
            && lhs.state.hasActiveToolCall == rhs.state.hasActiveToolCall
            && lhs.state.canInlineProcessing == rhs.state.canInlineProcessing
            && lhs.state.shouldShowThinkingIndicator == rhs.state.shouldShowThinkingIndicator
            && lhs.state.hasMessages == rhs.state.hasMessages
            && lhs.providerCatalogHash == rhs.providerCatalogHash
            && lhs.isLoadingMoreMessages == rhs.isLoadingMoreMessages
            && lhs.isCompacting == rhs.isCompacting
            && lhs.isInteractionEnabled == rhs.isInteractionEnabled
            && lhs.containerWidth == rhs.containerWidth
            && lhs.dismissedDocumentSurfaceIds == rhs.dismissedDocumentSurfaceIds
            && lhs.activeSurfaceId == rhs.activeSurfaceId
            && lhs.highlightedMessageId == rhs.highlightedMessageId
            && lhs.mediaEmbedSettings == rhs.mediaEmbedSettings
            && lhs.hasEverSentMessage == rhs.hasEverSentMessage
            && lhs.showInspectButton == rhs.showInspectButton
            && lhs.isTTSEnabled == rhs.isTTSEnabled
            && lhs.selectedModel == rhs.selectedModel
            && lhs.configuredProviders == rhs.configuredProviders
            && lhs.subagentDetailStore === rhs.subagentDetailStore
            && lhs.assistantStatusText == rhs.assistantStatusText
    }

    // MARK: - Data properties (compared in ==)

    let state: MessageListDerivedState
    let providerCatalog: [ProviderCatalogEntry]
    let providerCatalogHash: Int
    let isLoadingMoreMessages: Bool
    let isCompacting: Bool
    let isInteractionEnabled: Bool
    let containerWidth: CGFloat
    let dismissedDocumentSurfaceIds: Set<String>
    let activeSurfaceId: String?
    let highlightedMessageId: UUID?
    let mediaEmbedSettings: MediaEmbedResolverSettings?
    let hasEverSentMessage: Bool
    let showInspectButton: Bool
    let isTTSEnabled: Bool
    let selectedModel: String
    let configuredProviders: Set<String>
    let subagentDetailStore: SubagentDetailStore
    let assistantStatusText: String?

    // MARK: - @Observable references (not compared in ==; reads occur in closures or child views)

    let scrollState: MessageListScrollState
    let appearance: AvatarAppearanceManager

    // MARK: - Closures (skipped in ==)

    var onConfirmationAllow: ((String) -> Void)?
    var onConfirmationDeny: ((String) -> Void)?
    var onAlwaysAllow: ((String, String, String, String) -> Void)?
    var onTemporaryAllow: ((String, String) -> Void)?
    var onGuardianAction: ((String, String) -> Void)?
    var onSurfaceAction: ((String, String, [String: AnyCodable]?) -> Void)?
    var onDismissDocumentWidget: ((String) -> Void)?
    var onForkFromMessage: ((String) -> Void)?
    var onInspectMessage: ((String?) -> Void)?
    var onRehydrateMessage: ((UUID) -> Void)?
    var onSurfaceRefetch: ((String, String) -> Void)?
    var onRetryFailedMessage: ((UUID) -> Void)?
    var onRetryConversationError: ((UUID) -> Void)?
    var onAbortSubagent: ((String) -> Void)?
    var onSubagentTap: ((String) -> Void)?

    // MARK: - Thinking indicator helpers

    @ViewBuilder
    private func thinkingIndicatorRow(hasUserMessage: Bool) -> some View {
        RunningIndicator(
            label: !hasEverSentMessage && hasUserMessage
                ? "Waking up..."
                : assistantStatusText ?? "Thinking",
            showIcon: false
        )
        .frame(maxWidth: VSpacing.chatBubbleMaxWidth, alignment: .leading)
        .id("thinking-indicator")
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    @ViewBuilder
    private func compactingIndicatorRow() -> some View {
        RunningIndicator(
            label: "Compacting context\u{2026}",
            showIcon: false
        )
        .frame(maxWidth: VSpacing.chatBubbleMaxWidth, alignment: .leading)
        .id("compacting-indicator")
        .transition(.opacity.combined(with: .move(edge: .bottom)))
    }

    @ViewBuilder
    private var thinkingAvatarRow: some View {
        let avatarSize = ConversationAvatarFollower.avatarSize
        if appearance.customAvatarImage != nil {
            HStack {
                VAvatarImage(image: appearance.chatAvatarImage, size: avatarSize)
                Spacer()
            }
            .accessibilityHidden(true)
        } else if let body = appearance.characterBodyShape,
                  let eyes = appearance.characterEyeStyle,
                  let color = appearance.characterColor {
            HStack {
                AnimatedAvatarView(bodyShape: body, eyeStyle: eyes, color: color,
                                   size: avatarSize, blinkEnabled: true, pokeEnabled: true,
                                   isStreaming: true)
                    .frame(width: avatarSize, height: avatarSize)
                Spacer()
            }
            .accessibilityHidden(true)
        } else {
            HStack {
                VAvatarImage(image: appearance.chatAvatarImage, size: avatarSize)
                Spacer()
            }
            .accessibilityHidden(true)
        }
    }

    // MARK: - Body

    var body: some View {
        LazyVStack(alignment: .leading, spacing: VSpacing.md) {
            if isLoadingMoreMessages {
                HStack {
                    Spacer()
                    ProgressView()
                        .controlSize(.small)
                    Spacer()
                }
                .padding(.vertical, VSpacing.sm)
                .id("page-loading-indicator")
            }

            let _ = os_signpost(.event, log: stallLog, name: "MessageList.bodyEval")
            ForEach(state.displayMessages, id: \.id) { message in
                let index = state.messageIndexById[message.id] ?? 0
                MessageCellView(
                    message: message,
                    index: index,
                    showTimestamp: state.showTimestamp.contains(message.id),
                    nextDecidedConfirmation: state.nextDecidedConfirmationByIndex[index],
                    isConfirmationRenderedInline: state.isConfirmationRenderedInlineByIndex.contains(index),
                    hasPrecedingAssistant: state.hasPrecedingAssistantByIndex.contains(index),
                    hasUserMessage: state.hasUserMessage,
                    hasEverSentMessage: hasEverSentMessage,
                    activePendingRequestId: state.activePendingRequestId,
                    latestAssistantId: state.latestAssistantId,
                    anchoredThinkingIndex: state.anchoredThinkingIndex,
                    subagentsByParent: state.subagentsByParent,
                    canInlineProcessing: state.canInlineProcessing,
                    shouldShowThinkingIndicator: state.shouldShowThinkingIndicator,
                    assistantStatusText: state.effectiveStatusText,
                    dismissedDocumentSurfaceIds: dismissedDocumentSurfaceIds,
                    activeSurfaceId: activeSurfaceId,
                    isHighlighted: highlightedMessageId == message.id,
                    mediaEmbedSettings: mediaEmbedSettings,
                    onConfirmationAllow: onConfirmationAllow,
                    onConfirmationDeny: onConfirmationDeny,
                    onAlwaysAllow: onAlwaysAllow,
                    onTemporaryAllow: onTemporaryAllow,
                    onGuardianAction: onGuardianAction,
                    onSurfaceAction: onSurfaceAction,
                    onDismissDocumentWidget: onDismissDocumentWidget,
                    onForkFromMessage: onForkFromMessage,
                    showInspectButton: showInspectButton,
                    isTTSEnabled: isTTSEnabled,
                    onInspectMessage: onInspectMessage,
                    onRehydrateMessage: onRehydrateMessage,
                    onSurfaceRefetch: onSurfaceRefetch,
                    onRetryFailedMessage: onRetryFailedMessage,
                    onRetryConversationError: onRetryConversationError,
                    onAbortSubagent: onAbortSubagent,
                    onSubagentTap: onSubagentTap,
                    subagentDetailStore: subagentDetailStore,
                    selectedModel: selectedModel,
                    configuredProviders: configuredProviders,
                    providerCatalog: providerCatalog,
                    providerCatalogHash: providerCatalogHash
                )
                .equatable()
            }

            ForEach(state.orphanSubagents) { subagent in
                SubagentEventsReader(
                    store: subagentDetailStore,
                    subagent: subagent,
                    onAbort: { onAbortSubagent?(subagent.id) },
                    onTap: { onSubagentTap?(subagent.id) }
                )
                    .frame(maxWidth: VSpacing.chatBubbleMaxWidth, alignment: .leading)
                    .id("subagent-\(subagent.id)")
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }

            if state.shouldShowThinkingIndicator && state.anchoredThinkingIndex == nil {
                if isCompacting {
                    compactingIndicatorRow()
                } else {
                    thinkingIndicatorRow(hasUserMessage: state.hasUserMessage)
                }
                thinkingAvatarRow
            } else if isCompacting && !state.shouldShowThinkingIndicator && !state.canInlineProcessing {
                compactingIndicatorRow()
            }

            Color.clear.frame(height: 1)
                .id("scroll-bottom-anchor")
                .onAppear {
                    if !scrollState.hasBeenInteracted {
                        scrollState.handleReachedBottom()
                    }
                }

            TailSpacerView(scrollState: scrollState)
        }
        .disabled(!isInteractionEnabled)
        .padding(.horizontal, VSpacing.xl)
        .padding(.top, VSpacing.md)
        .padding(.bottom, VSpacing.md)
        .frame(maxWidth: VSpacing.chatColumnMaxWidth)
        .frame(maxWidth: .infinity)
        .environment(\.bubbleMaxWidth, containerWidth > 0
            ? min(VSpacing.chatBubbleMaxWidth, max(containerWidth - 2 * VSpacing.xl, 0))
            : VSpacing.chatBubbleMaxWidth)
    }
}
