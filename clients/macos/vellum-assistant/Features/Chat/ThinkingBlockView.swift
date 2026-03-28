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

                ScrollView {
                    Text(content)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentSecondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(VSpacing.sm)
                }
                .frame(maxHeight: 300)
            }
        }
        .background(VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
    }

    // MARK: - Header

    private var headerRow: some View {
        Button(action: {
            withAnimation(.easeInOut(duration: 0.2)) {
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
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
    }
}
