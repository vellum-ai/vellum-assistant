import SwiftUI
import VellumAssistantShared

/// Skeleton placeholder for the chat area while a conversation is loading.
/// Mimics the real `ChatBubble` layout — a short user message followed by a
/// multi-line assistant response — so the transition to real content feels seamless.
struct ChatLoadingSkeleton: View {
    /// Measured width of the chat container, threaded from ChatView.
    var containerWidth: CGFloat = 0

    /// Line widths for the multi-line assistant text block.
    /// Varying lengths look more natural than uniform bones.
    private let assistantLineWidths: [CGFloat] = [0.92, 0.85, 0.78, 0.95, 0.70, 0.45]

    /// Darker bone that uses a subtler shimmer to avoid the bright white sweep.
    private func chatBone(width: CGFloat? = nil, height: CGFloat = 14) -> some View {
        RoundedRectangle(cornerRadius: VRadius.sm)
            .fill(VColor.contentTertiary.opacity(0.15))
            .frame(width: width, height: height)
            .vShimmer(highlightColor: VColor.contentTertiary.opacity(0.1))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            userMessage
            assistantMessage
            Spacer(minLength: 0)
        }
        // When containerWidth is provided, .frame(width:) creates
        // _FrameLayout — no alignment queries. When containerWidth is 0
        // (callers that don't thread it), fall back to flexible maxWidth
        // so the skeleton adapts to narrow parent proposals.
        .frame(
            width: containerWidth > 0
                ? min(containerWidth, VSpacing.chatColumnMaxWidth) : nil,
            maxWidth: containerWidth > 0
                ? nil : VSpacing.chatColumnMaxWidth,
            alignment: .leading
        )
    }

    // MARK: - User Message

    /// Right-aligned user bubble with two text lines inside,
    /// matching real ChatBubble user styling (fill + padding + corner radius).
    private var userMessage: some View {
        VStack(alignment: .trailing, spacing: VSpacing.xs) {
            chatBone(height: 14)
            chatBone(height: 14)
                .frame(maxWidth: VSpacing.chatBubbleMaxWidth * 0.45, alignment: .trailing)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceActive)
        )
        .frame(maxWidth: VSpacing.chatBubbleMaxWidth * 0.65)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    // MARK: - Assistant Message

    /// Left-aligned assistant block with text lines,
    /// matching real ChatBubble assistant layout.
    private var assistantMessage: some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(assistantLineWidths.indices, id: \.self) { idx in
                    chatBone(height: 14)
                        .frame(
                            maxWidth: VSpacing.chatBubbleMaxWidth * assistantLineWidths[idx],
                            alignment: .leading
                        )
                }
            }
            .frame(maxWidth: VSpacing.chatBubbleMaxWidth, alignment: .leading)

            Spacer(minLength: 0)
        }
    }
}
