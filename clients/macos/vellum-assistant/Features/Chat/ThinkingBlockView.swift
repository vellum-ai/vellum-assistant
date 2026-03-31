#if os(macOS)
import AppKit
#endif
import SwiftUI
import VellumAssistantShared

/// A collapsible card that displays LLM thinking/reasoning content.
/// Starts collapsed by default. Shows "Thinking..." during streaming
/// and "Thought process" when complete.
struct ThinkingBlockView: View {
    let content: String
    let isStreaming: Bool

    @State private var isExpanded: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerRow

            if isExpanded {
                Divider()
                    .padding(.horizontal, VSpacing.sm)

                #if os(macOS)
                VSelectableTextView(
                    attributedString: NSAttributedString(
                        string: content,
                        attributes: [
                            .font: VFont.nsBodyMediumDefault,
                            .foregroundColor: NSColor(VColor.contentSecondary),
                        ]
                    ),
                    lineSpacing: 0
                )
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(VSpacing.sm)
                .transition(.opacity)
                #else
                Text(content)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(VSpacing.sm)
                    .transition(.opacity)
                #endif
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
