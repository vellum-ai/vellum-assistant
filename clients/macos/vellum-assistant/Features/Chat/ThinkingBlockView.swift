import SwiftUI
import VellumAssistantShared

/// A collapsible card that displays LLM thinking/reasoning content.
/// Starts collapsed by default. Shows "Thinking..." during streaming
/// and "Thought process" when complete.
///
/// Expansion state lives in a `ThinkingBlockExpansionStore` injected via
/// `@Environment` rather than local `@State`, so manual expansion survives
/// the view-tree destruction that happens when `MessageListContentView`
/// flips its `.if` min-height wrapper at the start/end of an active turn.
struct ThinkingBlockView: View {
    let content: String
    let isStreaming: Bool
    let expansionKey: String
    var typographyGeneration: Int = 0

    @Environment(\.thinkingBlockExpansionStore) private var expansionStore

    /// Cached parsed markdown segments — parsed lazily only when the block is
    /// expanded, avoiding synchronous O(n) work while collapsed (the default).
    @State private var cachedSegments: [MarkdownSegment] = []
    @State private var cachedContent: String = ""

    private var isExpanded: Bool {
        expansionStore.isExpanded(expansionKey)
    }

    /// Seed the segment cache when the block is (or becomes) expanded and the
    /// content has drifted from the cache. Called from `onAppear` as well as
    /// `onChange` — `onAppear` is the critical one: when `MessageListContentView`
    /// tears down and rebuilds the view subtree at the end of an active turn,
    /// the view is recreated with `isExpanded == true` (from the store) but
    /// empty `@State` caches, and neither `onChange` handler fires on initial
    /// values. Without this, expanded blocks go blank at turn end until the
    /// user collapses and re-expands them.
    private func syncCacheIfExpanded() {
        guard isExpanded, cachedContent != content else { return }
        cachedContent = content
        cachedSegments = parseMarkdownSegments(content)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerRow

            if isExpanded {
                Divider()
                    .padding(.horizontal, VSpacing.sm)

                // ⚠️ No .frame(maxWidth:) in LazyVStack cells — see AGENTS.md.
                MarkdownSegmentView(
                    segments: cachedSegments,
                    isStreaming: isStreaming,
                    typographyGeneration: typographyGeneration,
                    maxContentWidth: nil,
                    textColor: VColor.contentSecondary,
                    secondaryTextColor: VColor.contentTertiary,
                    mutedTextColor: VColor.contentTertiary,
                    tintColor: VColor.primaryBase,
                    codeTextColor: VColor.contentDefault,
                    codeBackgroundColor: VColor.surfaceBase
                )
                .padding(VSpacing.sm)
                .transition(.opacity)
            }
        }
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .animation(VAnimation.fast, value: isExpanded)
        .onAppear { syncCacheIfExpanded() }
        .onChange(of: content) { _, _ in syncCacheIfExpanded() }
        .onChange(of: isExpanded) { _, _ in syncCacheIfExpanded() }
    }

    // MARK: - Header

    private var headerRow: some View {
        Button(action: {
            withAnimation(VAnimation.fast) {
                expansionStore.toggle(expansionKey)
            }
        }) {
            HStack(spacing: VSpacing.sm) {
                VIconView(.brain, size: 11)
                    .foregroundStyle(VColor.contentSecondary)

                Text(isStreaming ? "Thinking..." : "Thought process")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentSecondary)

                Spacer()

                VIconView(isExpanded ? .chevronUp : .chevronDown, size: 9)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .environment(\.isEnabled, true)
        .pointerCursor()
    }
}
