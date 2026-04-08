import SwiftUI
import VellumAssistantShared

/// A collapsible card that displays LLM thinking/reasoning content.
/// Starts collapsed by default. Shows "Thinking..." during streaming
/// and "Thought process" when complete.
struct ThinkingBlockView: View {
    let content: String
    let isStreaming: Bool
    var typographyGeneration: Int = 0

    @State private var isExpanded: Bool
    /// Cached parsed markdown segments — parsed lazily only when the block is
    /// expanded, avoiding synchronous O(n) work while collapsed (the default).
    @State private var cachedSegments: [MarkdownSegment]
    @State private var cachedContent: String

    init(content: String, isStreaming: Bool, typographyGeneration: Int = 0, initiallyExpanded: Bool = false) {
        self.content = content
        self.isStreaming = isStreaming
        self.typographyGeneration = typographyGeneration
        _isExpanded = State(initialValue: initiallyExpanded)
        if initiallyExpanded {
            _cachedSegments = State(initialValue: parseMarkdownSegments(content))
            _cachedContent = State(initialValue: content)
        } else {
            _cachedSegments = State(initialValue: [])
            _cachedContent = State(initialValue: "")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerRow

            if isExpanded {
                Divider()
                    .padding(.horizontal, VSpacing.sm)

                // ⚠️ Do NOT add .frame(maxWidth:, alignment:) here.
                // FlexFrame alignment queries recurse through all children — see AGENTS.md.
                // The parent VStack(alignment: .leading) already provides leading alignment.
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
                isExpanded.toggle()
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
