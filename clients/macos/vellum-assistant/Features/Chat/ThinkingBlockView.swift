import SwiftUI
import VellumAssistantShared

/// A collapsible card that displays LLM thinking/reasoning content.
/// Starts collapsed by default. Shows "Thinking..." during streaming
/// and "Thought process" when complete.
struct ThinkingBlockView: View {
    let content: String
    let isStreaming: Bool

    @State private var isExpanded: Bool

    init(content: String, isStreaming: Bool, initiallyExpanded: Bool = false) {
        self.content = content
        self.isStreaming = isStreaming
        _isExpanded = State(initialValue: initiallyExpanded)
    }

    static func makeMarkdownView(content: String, isStreaming: Bool) -> MarkdownSegmentView {
        MarkdownSegmentView(
            segments: parseMarkdownSegments(content),
            isStreaming: isStreaming,
            maxContentWidth: nil,
            textColor: VColor.contentSecondary,
            secondaryTextColor: VColor.contentTertiary,
            mutedTextColor: VColor.contentTertiary,
            tintColor: VColor.primaryBase,
            codeTextColor: VColor.contentDefault,
            codeBackgroundColor: VColor.surfaceBase
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerRow

            if isExpanded {
                Divider()
                    .padding(.horizontal, VSpacing.sm)

                Self.makeMarkdownView(content: content, isStreaming: isStreaming)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.sm)
                .transition(.opacity)
            }
        }
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
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
