import os
import os.signpost
import SwiftUI
import VellumAssistantShared

private let stallLog = OSLog(subsystem: "com.vellum.assistant", category: "LayoutStall")
private let scrollDiag = Logger(subsystem: Bundle.appBundleIdentifier, category: "ScrollDiag")

// MARK: - MessageListContentView

/// Inner rendering view that owns the expensive `LazyVStack` + `ForEach`.
///
/// `Equatable` + `.equatable()` prevents body re-evaluation when only the
/// outer `MessageListView`'s lifecycle properties (`@Binding`, `@State`,
/// `@Observable` reads) change. The outer view's body is cheap — it creates
/// this struct and applies scroll/lifecycle modifiers. This view's body is
/// expensive — it drives `LazyStack.measureEstimates` over all visible cells.
///
/// Closures and `@Observable` references (`scrollState`) are intentionally
/// skipped in `==` — closures are never equal, and `@Observable` objects are
/// identity-stable. Only data properties that affect rendered output are
/// compared.
///
/// - SeeAlso: [WWDC23 — Demystify SwiftUI performance](https://developer.apple.com/videos/play/wwdc2023/10160/)
/// - SeeAlso: [Airbnb — Understanding and Improving SwiftUI Performance](https://airbnb.tech/mobile/understanding-and-improving-swiftui-performance/)
struct MessageListContentView: View, Equatable {

    // MARK: - Equatable

    static func == (lhs: MessageListContentView, rhs: MessageListContentView) -> Bool {
        lhs.state == rhs.state
            && lhs.providerCatalogHash == rhs.providerCatalogHash
            && lhs.typographyGeneration == rhs.typographyGeneration
            && lhs.isLoadingMoreMessages == rhs.isLoadingMoreMessages
            && lhs.isCompacting == rhs.isCompacting
            && lhs.isInteractionEnabled == rhs.isInteractionEnabled
            && lhs.layoutMetrics == rhs.layoutMetrics
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

    let state: TranscriptRenderModel
    let providerCatalog: [ProviderCatalogEntry]
    let providerCatalogHash: Int
    let typographyGeneration: Int
    let isLoadingMoreMessages: Bool
    let isCompacting: Bool
    let isInteractionEnabled: Bool
    let layoutMetrics: MessageListLayoutMetrics
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

    private var effectiveBubbleMaxWidth: CGFloat {
        layoutMetrics.bubbleMaxWidth
    }

    @ViewBuilder
    private func thinkingIndicatorRow(hasUserMessage: Bool) -> some View {
        HStack(spacing: VSpacing.sm) {
            TypingIndicatorView()
            let label = !hasEverSentMessage && hasUserMessage
                ? "Waking up..."
                : assistantStatusText
            if let label, !label.isEmpty {
                Text(label)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }
            Spacer()
        }
        .frame(width: effectiveBubbleMaxWidth)
        .id("thinking-indicator")
        .transition(.opacity)
    }

    @ViewBuilder
    private func compactingIndicatorRow() -> some View {
        RunningIndicator(
            label: "Compacting context\u{2026}",
            showIcon: false
        )
        .frame(width: effectiveBubbleMaxWidth)
        .id("compacting-indicator")
        .transition(.opacity)
    }

    @ViewBuilder
    private var thinkingAvatarRow: some View {
        let appearance = AvatarAppearanceManager.shared
        let avatarSize = ConversationAvatarFollower.avatarSize
        HStack {
            if appearance.customAvatarImage != nil {
                VAvatarImage(image: appearance.chatAvatarImage, size: avatarSize)
            } else if let body = appearance.characterBodyShape,
                      let eyes = appearance.characterEyeStyle,
                      let color = appearance.characterColor {
                AnimatedAvatarView(bodyShape: body, eyeStyle: eyes, color: color,
                                   size: avatarSize, blinkEnabled: true, pokeEnabled: true,
                                   isStreaming: true)
                    .frame(width: avatarSize, height: avatarSize)
            } else {
                VAvatarImage(image: appearance.chatAvatarImage, size: avatarSize)
            }
            Spacer()
        }
        .padding(.top, VSpacing.sm)
        .accessibilityHidden(true)
    }

    // MARK: - Body

    var body: some View {
        // WARNING: This LazyVStack uses .transaction { $0.animation = nil } to suppress
        // all insertion/removal animations. Without this, SwiftUI calls motionVectors()
        // during any item insertion, which measures ALL children via sizeThatFits —
        // causing multi-minute hangs on long conversations. Do NOT remove the
        // .transaction modifier or wrap content changes in withAnimation.
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
            // Min height for the active assistant turn — ensures the user message
            // can reach the top of the viewport when content is short.
            // viewportHeight is initialized to .infinity until the scroll view lays
            // out; guard against non-finite values so we never pass NaN/∞ into
            // .frame(minHeight:), which trips _NSViewValidateGeometry in AppKit.
            let turnMinHeight: CGFloat = scrollState.viewportHeight.isFinite
                ? max(0, scrollState.viewportHeight - 150)
                : 0
            // Track whether the minHeight wrapper is applied so
            // executeScrollToBottom can target the content-bottom marker.
            let minHeightApplied: Bool = {
                guard state.isActiveTurn, let lastRow = state.rows.last else { return false }
                return lastRow.isLatestAssistant && lastRow.message.id == state.rows.last?.message.id
            }()
            let _ = {
                let wasApplied = scrollState.isActiveTurnMinHeightApplied
                scrollState.isActiveTurnMinHeightApplied = minHeightApplied
                // Reset the push-to-top flag when the active turn ends so
                // the next turn gets a fresh initial pin with lastMessageId.
                if !minHeightApplied { scrollState.hasCompletedInitialPushToTop = false }
                if wasApplied != minHeightApplied {
                    scrollDiag.debug("minHeightApplied changed: \(wasApplied, privacy: .public) → \(minHeightApplied, privacy: .public) isActiveTurn=\(state.isActiveTurn, privacy: .public) rowCount=\(state.rows.count, privacy: .public)")
                }
            }()
            let isUnanchoredThinking = state.shouldShowThinkingIndicator && !state.rows.contains(where: \.isAnchoredThinkingRow)
            let thinkingLabel = !hasEverSentMessage && state.hasUserMessage
                ? "Waking up..."
                : (state.effectiveStatusText ?? "Thinking")
            ForEach(state.rows) { row in
                // Only pass activePendingRequestId to cells that could use it:
                // confirmation bubbles need it for keyboard focus, tool-call messages
                // need it for inline confirmation rendering in AssistantProgressView.
                // Text-only cells get nil, so they won't fail == when the ID changes.
                let cellActivePendingRequestId: String? =
                    (row.message.confirmation != nil || !row.message.toolCalls.isEmpty)
                    ? state.activePendingRequestId : nil
                MessageCellView(
                    message: row.message,
                    showTimestamp: row.showTimestamp,
                    nextDecidedConfirmation: row.decidedConfirmation,
                    isConfirmationRenderedInline: row.isConfirmationRenderedInline,
                    hasPrecedingAssistant: row.hasPrecedingAssistant,
                    activePendingRequestId: cellActivePendingRequestId,
                    subagentsByParent: state.subagentsByParent,
                    isLatestAssistantMessage: row.isLatestAssistant,
                    typographyGeneration: typographyGeneration,
                    isProcessingAfterTools: state.canInlineProcessing && row.isLatestAssistant,
                    processingStatusText: state.canInlineProcessing && row.isLatestAssistant ? state.effectiveStatusText : nil,
                    hideInlineAvatar: row.isLatestAssistant && isUnanchoredThinking,
                    showAnchoredThinkingIndicator: row.isAnchoredThinkingRow,
                    anchoredThinkingLabel: row.isAnchoredThinkingRow ? thinkingLabel : "",
                    dismissedDocumentSurfaceIds: dismissedDocumentSurfaceIds,
                    activeSurfaceId: activeSurfaceId,
                    isHighlighted: row.isHighlighted,
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
                // Active assistant turn: wrap in VStack with minHeight so user
                // message sits at top. Only applies while the assistant has an
                // active turn (sending, thinking, streaming, tool running).
                .if(state.isActiveTurn && row.isLatestAssistant && row.message.id == state.rows.last?.message.id) { view in
                    VStack(spacing: 0) {
                        view
                        Color.clear.frame(height: 1)
                            .id("active-turn-content-bottom")
                    }
                    .frame(minHeight: turnMinHeight, alignment: .top)
                }
            }

            ForEach(state.orphanSubagents) { subagent in
                // ⚠️ No .frame(maxWidth:) in LazyVStack cells — see AGENTS.md.
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
                    .transition(.opacity)
            }

            if isUnanchoredThinking {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    if isCompacting {
                        compactingIndicatorRow()
                    } else {
                        thinkingIndicatorRow(hasUserMessage: state.hasUserMessage)
                    }
                    thinkingAvatarRow
                }
                .frame(minHeight: turnMinHeight, alignment: .top)
            } else if state.isStreamingWithoutText && !state.canInlineProcessing {
                VStack(spacing: 0) {
                    HStack {
                        TypingIndicatorView()
                        Spacer()
                    }
                    .frame(width: effectiveBubbleMaxWidth)
                }
                .frame(minHeight: turnMinHeight, alignment: .top)
                .id("streaming-without-text-indicator")
                .transition(.opacity)
            } else if isCompacting && !state.shouldShowThinkingIndicator && !state.canInlineProcessing {
                VStack(spacing: 0) { compactingIndicatorRow() }
                    .frame(minHeight: turnMinHeight, alignment: .top)
            }

            Color.clear.frame(height: 1)
                .id("scroll-bottom-anchor")
                .onAppear {
                    // Signal that the bottom anchor has materialized —
                    // isAtBottom is now reliable (based on actual content
                    // height, not LazyVStack estimates).
                    scrollState.bottomAnchorAppeared = true
                    if !scrollState.hasBeenInteracted {
                        scrollState.handleReachedBottom()
                    }
                }
        }
        .disabled(!isInteractionEnabled)
        .transaction { $0.animation = nil }
        .padding(EdgeInsets(top: VSpacing.md, leading: VSpacing.xl,
                            bottom: VSpacing.md, trailing: VSpacing.xl))
        .environment(\.bubbleMaxWidth, layoutMetrics.bubbleMaxWidth)
    }
}
