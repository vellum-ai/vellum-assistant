import SwiftUI
import VellumAssistantShared

/// Skeleton placeholder for the chat area while a thread is loading.
/// Mimics the real `ChatBubble` layout — a short user message followed by a
/// multi-line assistant response — so the transition to real content feels seamless.
struct ChatLoadingSkeleton: View {
    /// Line widths for the multi-line assistant text block.
    /// Varying lengths look more natural than uniform bones.
    private let assistantLineWidths: [CGFloat] = [0.92, 0.85, 0.78, 0.95, 0.70, 0.45]

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            userMessage
            assistantMessage
        }
        .frame(maxWidth: VSpacing.chatColumnMaxWidth, alignment: .leading)
    }

    // MARK: - User Message

    /// Right-aligned user bubble with two short text lines inside,
    /// matching real ChatBubble user styling (fill + padding + corner radius).
    private var userMessage: some View {
        VStack(alignment: .trailing, spacing: VSpacing.xs) {
            VSkeletonBone(width: 180, height: 14, radius: VRadius.sm)
            VSkeletonBone(width: 120, height: 14, radius: VRadius.sm)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceBorder.opacity(0.25))
        )
        .frame(maxWidth: VSpacing.chatBubbleMaxWidth, alignment: .trailing)
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    // MARK: - Assistant Message

    /// Left-aligned assistant block with avatar placeholder and six text lines,
    /// matching real ChatBubble assistant layout (28pt avatar + 8pt gap + content).
    private var assistantMessage: some View {
        HStack(alignment: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                ForEach(assistantLineWidths.indices, id: \.self) { idx in
                    VSkeletonBone(
                        height: 14,
                        radius: VRadius.sm
                    )
                    .frame(
                        maxWidth: VSpacing.chatBubbleMaxWidth * assistantLineWidths[idx],
                        alignment: .leading
                    )
                }
            }
            .frame(maxWidth: VSpacing.chatBubbleMaxWidth, alignment: .leading)
            .overlay(alignment: .topLeading) {
                // Avatar bone positioned identically to real ChatBubble
                VSkeletonBone(width: 28, height: 28, radius: VRadius.pill)
                    .offset(x: -(28 + VSpacing.sm), y: 0)
            }
            .padding(.leading, 28 + VSpacing.sm)

            Spacer(minLength: 0)
        }
    }
}

#if DEBUG
#Preview("ChatLoadingSkeleton") {
    ZStack {
        VColor.background.ignoresSafeArea()
        ChatLoadingSkeleton()
            .padding(VSpacing.lg)
    }
    .frame(width: 700, height: 400)
}
#endif
