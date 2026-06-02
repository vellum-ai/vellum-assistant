import os
import os.signpost
import SwiftUI
import VellumAssistantShared

private let stallLog = OSLog(subsystem: "com.vellum.assistant", category: "LayoutStall")

// MARK: - MessageListContentView

/// Inner rendering view that owns the expensive `LazyVStack` + `ForEach`.
///
/// `Equatable` + `.equatable()` prevents body re-evaluation when only the
/// outer `MessageListView`'s lifecycle properties (`@Binding`, `@State`) change.
/// The outer view's body is cheap — it creates this struct and applies
/// scroll/lifecycle modifiers. This view's body is expensive — it drives
/// `LazyStack.measureEstimates` over all visible cells.
///
/// Closures are intentionally skipped in `==` — closures are never equal.
/// `subagentDetailStore` is identity-compared because the instance is stable
/// across render passes. Only data properties that affect rendered output are
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
            && lhs.autoRoutedProfileLabel == rhs.autoRoutedProfileLabel
            && lhs.pinnedLatestTurnAnchorMessageId == rhs.pinnedLatestTurnAnchorMessageId
            && lhs.searchQuery == rhs.searchQuery
            && lhs.bookmarkStore === rhs.bookmarkStore
            && lhs.bookmarkConversationId == rhs.bookmarkConversationId
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
    let autoRoutedProfileLabel: String?
    let pinnedLatestTurnAnchorMessageId: UUID?
    let searchQuery: String
    let bookmarkStore: BookmarkStore?
    let bookmarkConversationId: String?

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
    var onToggleBookmark: ((String, String) -> Void)?
    var onRehydrateMessage: ((UUID) -> Void)?
    var onSurfaceRefetch: ((String, String) -> Void)?
    var onRetryFailedMessage: ((UUID) -> Void)?
    var onRetryConversationError: ((UUID) -> Void)?
    var onAbortSubagent: ((String) -> Void)?
    var onSubagentTap: ((String) -> Void)?

    // MARK: - Thinking indicator helpers

    fileprivate var effectiveBubbleMaxWidth: CGFloat {
        layoutMetrics.bubbleMaxWidth
    }

    fileprivate var showsStandaloneLatestEdgeActivity: Bool {
        (state.isStreamingWithoutText && !state.canInlineProcessing)
            || (isCompacting && !state.shouldShowThinkingIndicator && !state.canInlineProcessing)
    }

    @ViewBuilder
    fileprivate func thinkingIndicatorRow(hasUserMessage: Bool) -> some View {
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
    fileprivate func compactingIndicatorRow() -> some View {
        RunningIndicator(
            label: "Compacting context\u{2026}",
            showIcon: false
        )
        .frame(width: effectiveBubbleMaxWidth)
        .id("compacting-indicator")
        .transition(.opacity)
    }

    @ViewBuilder
    fileprivate func latestEdgeSentinel(isFlipped: Bool = true) -> some View {
        Color.clear.frame(height: 1)
            .id("scroll-bottom-anchor")
            .if(isFlipped) { view in
                view.flipped()
            }
    }

    @ViewBuilder
    fileprivate func latestEdgeActivityRow(isFlipped: Bool = true) -> some View {
        if state.isStreamingWithoutText && !state.canInlineProcessing {
            HStack {
                TypingIndicatorView()
                Spacer()
            }
            .frame(width: effectiveBubbleMaxWidth)
            .id("streaming-without-text-indicator")
            .transition(.opacity)
            .if(isFlipped) { view in
                view.flipped()
            }
        } else if isCompacting && !state.shouldShowThinkingIndicator && !state.canInlineProcessing {
            compactingIndicatorRow()
                .if(isFlipped) { view in
                    view.flipped()
                }
        }
    }

    // MARK: - Auto-routed profile label

    @ViewBuilder
    fileprivate func autoRoutedProfileRow(isFlipped: Bool = true) -> some View {
        if let label = state.autoRoutedProfileLabel {
            HStack {
                Text("Using \(label) for this response")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                Spacer()
            }
            .frame(width: effectiveBubbleMaxWidth)
            .id("auto-routed-profile-label")
            .transition(.opacity)
            .if(isFlipped) { view in
                view.flipped()
            }
        }
    }

    // MARK: - Transcript row rendering

    /// Renders a single transcript row (either a real message cell or the
    /// synthetic thinking placeholder).
    @ViewBuilder
    fileprivate func transcriptRow(
        row: TranscriptRowModel,
        isUnanchoredThinking: Bool,
        thinkingLabel: String,
        isFlipped: Bool = true
    ) -> some View {
        Group {
            if row.isThinkingPlaceholder {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    if isCompacting {
                        compactingIndicatorRow()
                    } else {
                        thinkingIndicatorRow(hasUserMessage: state.hasUserMessage)
                    }
                    thinkingAvatarRow
                }
            } else {
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
                    isStreamingContinuation: state.isStreamingWithText && row.isLatestAssistant,
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
                    onToggleBookmark: onToggleBookmark,
                    bookmarkStore: bookmarkStore,
                    bookmarkConversationId: bookmarkConversationId,
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
                    providerCatalogHash: providerCatalogHash,
                    searchQuery: searchQuery
                )
                .equatable()
            }
        }
        .if(isFlipped) { view in
            view.flipped()
        }
    }

    @ViewBuilder
    fileprivate func queuedMarkerRow(count: Int, isFlipped: Bool = true) -> some View {
        QueuedMessagesMarker(count: count)
            .if(isFlipped) { view in
                view.flipped()
            }
    }

    @ViewBuilder
    fileprivate func transcriptItemView(
        _ item: TranscriptItem,
        rowsByMessageId: [UUID: TranscriptRowModel],
        isUnanchoredThinking: Bool,
        thinkingLabel: String,
        isFlipped: Bool = true
    ) -> some View {
        CachedHeightRow(itemId: item.id) {
            switch item {
            case .queuedMarker(let count):
                queuedMarkerRow(count: count, isFlipped: isFlipped)
            case .message(let message):
                if let row = rowsByMessageId[message.id] {
                    transcriptRow(
                        row: row,
                        isUnanchoredThinking: isUnanchoredThinking,
                        thinkingLabel: thinkingLabel,
                        isFlipped: isFlipped
                    )
                }
            }
        }
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
        // WARNING: .transaction { $0.animation = nil } below suppresses all
        // insertion/removal animations. Without it, SwiftUI calls motionVectors()
        // during any item insertion, which measures ALL children via sizeThatFits —
        // causing multi-minute hangs on long conversations. Do NOT remove the
        // .transaction modifier or wrap content mutations in withAnimation.
        MessageTranscriptStack(spacing: VSpacing.md) {
            let _ = os_signpost(.event, log: stallLog, name: "MessageList.bodyEval")
            let isUnanchoredThinking = state.shouldShowThinkingIndicator && !state.rows.contains(where: \.isAnchoredThinkingRow)
            let thinkingLabel = !hasEverSentMessage && state.hasUserMessage
                ? "Waking up..."
                : (state.effectiveStatusText ?? "Thinking")
            // Collapse consecutive inline queued user bubbles into a single
            // marker. The queued messages are still managed in the drawer
            // (`QueuedMessagesDrawer`) — rendering them inline here duplicates
            // the information and clutters the transcript when many follow-ups
            // are queued. The pure helper `TranscriptItems.build(from:)` is
            // shared in `clients/shared/Features/Chat/TranscriptItems.swift`.
            let rowsByMessageId: [UUID: TranscriptRowModel] = Dictionary(
                uniqueKeysWithValues: state.rows.map { ($0.message.id, $0) }
            )
            let displayedItems = TranscriptItems.build(from: state.rows.map(\.message))
            let pinnedTurnPartition = PinnedLatestTurnPartition.split(
                displayedItems: displayedItems,
                pinnedLatestTurnAnchorMessageId: pinnedLatestTurnAnchorMessageId
            )

            if let anchorMessage = pinnedTurnPartition.anchorMessage,
               let anchorRow = rowsByMessageId[anchorMessage.id] {

                PinnedLatestTurnSection(
                    contentView: self,
                    partition: pinnedTurnPartition,
                    rowsByMessageId: rowsByMessageId,
                    anchorRow: anchorRow,
                    isUnanchoredThinking: isUnanchoredThinking,
                    thinkingLabel: thinkingLabel
                )
                .id("pinned-latest-turn-\(anchorMessage.id.uuidString)")

                ForEach(pinnedTurnPartition.historyItems.reversed()) { item in
                    transcriptItemView(
                        item,
                        rowsByMessageId: rowsByMessageId,
                        isUnanchoredThinking: isUnanchoredThinking,
                        thinkingLabel: thinkingLabel
                    )
                }
            } else {
                // ── Coordinate TOP = Visual BOTTOM (near latest messages) ──
                // In the inverted scroll, the first items in the LazyVStack appear
                // at the visual bottom. Place current-activity indicators here.
                latestEdgeSentinel()
                latestEdgeActivityRow()
                autoRoutedProfileRow()

                // ── Messages ──
                ForEach(displayedItems.reversed()) { item in
                    transcriptItemView(
                        item,
                        rowsByMessageId: rowsByMessageId,
                        isUnanchoredThinking: isUnanchoredThinking,
                        thinkingLabel: thinkingLabel
                    )
                }
            }

            // ── Coordinate BOTTOM = Visual TOP (near oldest messages) ──
            // In the inverted scroll, the last items in the LazyVStack appear
            // at the visual top. Place the page-loading indicator here.
            if isLoadingMoreMessages {
                HStack {
                    Spacer()
                    ProgressView()
                        .controlSize(.small)
                    Spacer()
                }
                .padding(.vertical, VSpacing.sm)
                .id("page-loading-indicator")
                .flipped()
            }
        }
        .disabled(!isInteractionEnabled)
        .transaction { $0.animation = nil }
        .padding(EdgeInsets(top: VSpacing.md, leading: VSpacing.xl,
                            bottom: VSpacing.md, trailing: VSpacing.xl))
        .environment(\.bubbleMaxWidth, layoutMetrics.bubbleMaxWidth)
    }
}

// MARK: - Pinned Latest Turn

struct PinnedLatestTurnPartition: Equatable {
    let historyItems: [TranscriptItem]
    let anchorMessage: ChatMessage?
    let responseItems: [TranscriptItem]

    static func split(
        displayedItems: [TranscriptItem],
        pinnedLatestTurnAnchorMessageId: UUID?
    ) -> PinnedLatestTurnPartition {
        guard let pinnedLatestTurnAnchorMessageId,
              let anchorIndex = displayedItems.firstIndex(where: { item in
                  guard case .message(let message) = item else { return false }
                  return message.id == pinnedLatestTurnAnchorMessageId
              }),
              case .message(let anchorMessage) = displayedItems[anchorIndex],
              anchorMessage.role == .user
        else {
            return PinnedLatestTurnPartition(
                historyItems: displayedItems,
                anchorMessage: nil,
                responseItems: []
            )
        }

        let historyItems = Array(displayedItems[..<anchorIndex])
        let responseItems = anchorIndex < displayedItems.index(before: displayedItems.endIndex)
            ? Array(displayedItems[displayedItems.index(after: anchorIndex)...])
            : []
        return PinnedLatestTurnPartition(
            historyItems: historyItems,
            anchorMessage: anchorMessage,
            responseItems: responseItems
        )
    }
}

private struct PinnedLatestTurnSection: View {
    let contentView: MessageListContentView
    let partition: PinnedLatestTurnPartition
    let rowsByMessageId: [UUID: TranscriptRowModel]
    let anchorRow: TranscriptRowModel
    let isUnanchoredThinking: Bool
    let thinkingLabel: String

    // Filtered scroll-container visible height published by `MessageListView`
    // (see `ScrollViewportHeightKey` in `MessageListView.swift`). Used to
    // size the section's `topAlignedMinHeight` floor against the viewport.
    // `nil` until the first scroll-geometry callback lands.
    //
    // Read via `@Environment` so the value reaches us without going through
    // `MessageListContentView`'s `Equatable` props — keeps the `.equatable()`
    // barrier upstream intact while still letting this section react.
    @Environment(\.scrollViewportHeight) private var scrollViewportHeight: CGFloat?

    private var hasResponseContent: Bool {
        contentView.showsStandaloneLatestEdgeActivity
            || !partition.responseItems.isEmpty
    }

    /// Viewport-sized floor for the section, minus the outer transcript
    /// padding (`VSpacing.md` top + `VSpacing.md` bottom in
    /// `MessageListContentView.body`'s `EdgeInsets`) so the anchor row
    /// lands with the intended visual gap. `max(0, …)` guards transient
    /// zero-height layout passes SwiftUI runs during setup and
    /// window/split-view collapse — negative minimums cause layout
    /// warnings and unstable pinned-turn rendering.
    ///
    /// Defaults to `0` (not `nil`) before the first scroll measurement
    /// lands so `topAlignedMinHeight` always wraps the section in
    /// `TopAlignedMinHeightLayout`. The modifier is `@ViewBuilder` with
    /// `if let minHeight`, so a `nil → value` transition would flip the
    /// section's structural identity and rebuild every transcript row
    /// inside on the first measurement; pinning the initial value to
    /// `0` (sizing-equivalent to no floor since content is non-negative)
    /// keeps identity stable.
    private var viewportMinHeight: CGFloat {
        scrollViewportHeight.map { max(0, $0 - VSpacing.md * 2) } ?? 0
    }

    var body: some View {
        // Two flips (ScrollView + section) cancel out, so source order
        // equals visual order: anchor at top, response below, spacer
        // fills remaining viewport, sentinel marks the latest edge.
        //
        // `TopAlignedMinHeightLayout` gives the section a viewport-sized
        // floor while letting it grow when anchor + response exceeds the
        // viewport. Without the floor, the `Spacer` below cannot keep the
        // anchor pinned to the visual top while a short response streams.
        // Without growth, a tall response is capped at the viewport and
        // the newest content becomes unreachable by scroll.
        //
        // `.frame(minHeight:alignment: .top)` achieves the same sizing
        // but creates `_FlexFrameLayout`, whose `placeSubviews` queries
        // `explicitAlignment` on every descendant — O(n × depth) cascade.
        // `TopAlignedMinHeightLayout` returns `nil` from
        // `explicitAlignment`, stopping the cascade in O(1).
        VStack(alignment: .leading, spacing: 0) {
            contentView.transcriptRow(
                row: anchorRow,
                isUnanchoredThinking: isUnanchoredThinking,
                thinkingLabel: thinkingLabel,
                isFlipped: false
            )
            .id(anchorRow.id)

            responseCluster
                .alignmentBarrier()

            Spacer(minLength: 0)

            contentView.latestEdgeSentinel(isFlipped: false)
        }
        .topAlignedMinHeight(viewportMinHeight)
        .flipped()
    }

    @ViewBuilder
    private var responseCluster: some View {
        // LazyVStack so only visible response items are measured per
        // layout pass. The previous VStack eagerly measured ALL items,
        // causing O(N) layout work during agent conversations with many
        // tool calls (20-50+ response messages per turn).
        //
        // The outer `.transaction { $0.animation = nil }` on
        // MessageTranscriptStack propagates through the hierarchy,
        // suppressing insertion animations that would otherwise trigger
        // motionVectors — an O(n) sizeThatFits sweep that defeats lazy
        // loading.
        LazyVStack(alignment: .leading, spacing: VSpacing.md) {
            contentView.autoRoutedProfileRow(isFlipped: false)

            ForEach(partition.responseItems) { item in
                contentView.transcriptItemView(
                    item,
                    rowsByMessageId: rowsByMessageId,
                    isUnanchoredThinking: isUnanchoredThinking,
                    thinkingLabel: thinkingLabel,
                    isFlipped: false
                )
                .alignmentBarrier()
            }

            contentView.latestEdgeActivityRow(isFlipped: false)
        }
        .padding(.top, hasResponseContent ? VSpacing.md : 0)
    }
}
