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
        .onChange(of: content) { _, newContent in
            guard isExpanded, newContent != cachedContent else { return }
            cachedContent = newContent
            cachedSegments = parseMarkdownSegments(newContent)
        }
        .onChange(of: isExpanded) { _, expanded in
            guard expanded, cachedContent != content else { return }
            cachedContent = content
            cachedSegments = parseMarkdownSegments(content)
        }
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
